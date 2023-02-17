import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BotService } from '../bot/bot.service';
import SteamTradeOfferManager from 'steam-tradeoffer-manager';
import {
  CreateTradeDto,
  CreateTradeResponse,
  GetTradesDto,
  GetTradesResponse,
  TradeOffer,
} from '@tf2-automatic/bot-data';
import { EResultException } from '../common/exceptions/eresult.exception';
import { Config, SteamAccountConfig } from '../common/config/configuration';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common/services';
import { EventsService } from '../events/events.service';
import fastq from 'fastq';
import type { queueAsPromised } from 'fastq';
import SteamUser from 'steam-user';

interface EnsureOfferPublishedTask {
  id: string;
}

interface TradeOfferData {
  published?: SteamUser.ETradeOfferState;
}

@Injectable()
export class TradesService {
  private readonly logger: Logger = new Logger(TradesService.name);

  private readonly manager = this.botService.getManager();
  private readonly community = this.botService.getCommunity();

  private readonly ensureOfferPublishedQueue: queueAsPromised<EnsureOfferPublishedTask> =
    fastq.promise(this.ensureOfferPublished.bind(this), 1);

  private ensurePollDataTimeout: NodeJS.Timeout | null = null;

  constructor(
    private readonly botService: BotService,
    private readonly configService: ConfigService<Config>,
    private readonly eventsService: EventsService
  ) {
    this.manager.on('newOffer', (offer) => {
      this.publishOffer(offer, null);
    });

    this.manager.on('sentOfferChanged', (offer, oldState) => {
      this.publishOffer(offer, oldState);
    });

    this.manager.on('receivedOfferChanged', (offer, oldState) => {
      this.publishOffer(offer, oldState);
    });

    this.manager.on('pollData', () => {
      this.ensurePollData();
    });
  }

  private ensurePollData(): void {
    if (this.ensurePollDataTimeout !== null) {
      clearTimeout(this.ensurePollDataTimeout);
    }

    this.ensurePollDataTimeout = setTimeout(() => {
      this.logger.debug('Enqueuing offers to ensure poll data is published');
      Object.keys(this.manager.pollData.sent)
        .concat(Object.keys(this.manager.pollData.received))
        .forEach((id) => {
          this.ensureOfferPublishedQueue.push({ id }).catch((err) => {
            // Ignore the error
            this.logger.warn('Error ensuring offer published: ' + err.message);
            console.log(err);
          });
        });
    }, 1000);
  }

  private async ensureOfferPublished(
    task: EnsureOfferPublishedTask
  ): Promise<void> {
    const id = task.id;

    // Check if offer was already published
    const currentState =
      this.manager.pollData.sent[id] ??
      this.manager.pollData.received[id] ??
      null;

    if (currentState !== null) {
      const pollDataOfferData = this.manager.pollData.offerData ?? {};

      const offerData: TradeOfferData | null = pollDataOfferData[id] ?? null;
      const publishedState = offerData?.published ?? null;

      if (currentState === publishedState) {
        // Offer was already published
        return;
      }
    }

    // Get the actual offer
    const offer = await this._getTrade(id);
    const publishedState = offer.data('published') as
      | TradeOfferData['published']
      | null;

    if (offer.state === publishedState) {
      // This check is redundant but it's here just in case
      return;
    }

    return this.publishOffer(offer, publishedState);
  }

  private publishOffer(
    offer: SteamTradeOfferManager.TradeOffer,
    oldState: SteamUser.ETradeOfferState | null = null
  ): Promise<void> {
    const publish = (): Promise<void> => {
      if (oldState) {
        return this.eventsService.publish('trades.changed', {
          offer: this.mapOffer(offer),
          oldState,
        });
      }

      if (!offer.isOurOffer) {
        // Offer was sent to us and there is no old state
        if (offer.state === SteamTradeOfferManager.ETradeOfferState.Active) {
          // Offer is active, means we received it
          return this.eventsService.publish('trades.received', {
            offer: this.mapOffer(offer),
          });
        }

        // Offer is not active, means the state changed, but we don't know what it changed from
        return this.eventsService.publish('trades.changed', {
          offer: this.mapOffer(offer),
          oldState: null,
        });
      }

      // Offer is ours and there is no old state

      if (
        offer.state ===
        SteamTradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation
      ) {
        // Offer is waiting for confirmation, means we sent it
        return this.eventsService.publish('trades.sent', {
          offer: this.mapOffer(offer),
        });
      }

      if (offer.state === SteamTradeOfferManager.ETradeOfferState.Active) {
        // Offer is active, means it is either sent now or changed
        if (offer.itemsToGive.length === 0) {
          // Offer is active and we are giving nothing, means we sent it without confirmation
          return this.eventsService.publish('trades.sent', {
            offer: this.mapOffer(offer),
          });
        }
      }

      // Offer is not active, or created and needs confirmation.

      return this.eventsService.publish('trades.changed', {
        offer: this.mapOffer(offer),
        oldState: null,
      });
    };

    // Wait for the event to be published
    return publish()
      .then(() => {
        offer.data('published', offer.state);
      })
      .catch((err) => {
        this.logger.warn('Error publishing offer: ' + err.message);
      });
  }

  getTrades(dto: GetTradesDto): Promise<GetTradesResponse> {
    return new Promise<GetTradesResponse>((resolve, reject) => {
      this.manager.getOffers(
        dto.filter,
        (
          err: Error,
          sent: SteamTradeOfferManager.TradeOffer[],
          received: SteamTradeOfferManager.TradeOffer[]
        ) => {
          if (err) {
            return reject(err);
          }

          const sentMapped = sent.map((offer) => {
            return this.mapOffer(offer);
          });
          const receivedMapped = received.map((offer) => {
            return this.mapOffer(offer);
          });

          return resolve({ sent: sentMapped, received: receivedMapped });
        }
      );
    }).catch((err) => {
      this.logger.error(
        `Error getting trades: ${err.message}${
          err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
        }`
      );
      throw err;
    });
  }

  private _getTrade(id: string): Promise<SteamTradeOfferManager.TradeOffer> {
    return new Promise<TradeOffer>((resolve, reject) => {
      this.manager.getOffer(id, (err, offer) => {
        if (err) {
          if (err.message === 'NoMatch') {
            return reject(new BadRequestException('Trade offer not found'));
          }

          return reject(err);
        }

        return resolve(offer);
      });
    });
  }

  async getTrade(id: string): Promise<TradeOffer> {
    const offer = await this._getTrade(id).catch((err) => {
      this.logger.error(
        `Error getting trade offer: ${err.message}${
          err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
        }`
      );
      throw err;
    });

    return this.mapOffer(offer);
  }

  createTrade(dto: CreateTradeDto): Promise<CreateTradeResponse> {
    this.logger.log(`Sending trade offer to ${dto.partner}...`);

    return new Promise<CreateTradeResponse>((resolve, reject) => {
      const offer = this.manager.createOffer(dto.partner);

      if (dto.token) {
        offer.setToken(dto.token);
      }

      if (dto.message) {
        offer.setMessage(dto.message);
      }

      offer.addMyItems(dto.itemsToGive);
      offer.addTheirItems(dto.itemsToReceive);

      this.logger.debug(
        `Items to give: [${dto.itemsToGive
          .map((item) => `"${item.appid}_${item.contextid}_${item.assetid}"`)
          .join(',')}]`
      );
      this.logger.debug(
        `Items to receive: [${dto.itemsToReceive
          .map((item) => `"${item.appid}_${item.contextid}_${item.assetid}"`)
          .join(',')}]`
      );

      offer.send((err) => {
        if (err) {
          if (err.message === 'Cannot send an empty trade offer') {
            return reject(
              new BadRequestException('Cannot send an empty trade offer')
            );
          }

          if (err.eresult !== undefined) {
            return reject(new EResultException(err.message, err.eresult));
          }

          return reject(err);
        }

        return resolve(this.mapOffer(offer));
      });
    })
      .then((offer) => {
        this.logger.log(
          `Trade offer #${offer.id} sent to ${dto.partner} has status ${
            SteamTradeOfferManager.ETradeOfferState[offer.state]
          }`
        );
        return offer;
      })
      .catch((err) => {
        this.logger.error(
          `Got an error while sending trade offer: ${err.message}${
            err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
          }`
        );
        throw err;
      });
  }

  acceptConfirmation(id: string): Promise<void> {
    this.logger.log(`Accepting confirmation for offer #${id}...`);

    return new Promise<void>((resolve, reject) => {
      this.community.acceptConfirmationForObject(
        this.configService.getOrThrow<SteamAccountConfig>('steam')
          .identitySecret,
        id,
        (err) => {
          if (err) {
            if (
              err.message ===
              'Could not find confirmation for object ' + id
            ) {
              return reject(new NotFoundException('Confirmation not found'));
            }

            return reject(err);
          }

          return resolve();
        }
      );
    })
      .then(() => {
        this.logger.log(`Accepted confirmation for offer #${id}`);
        this.manager.doPoll();
      })
      .catch((err) => {
        this.logger.error(
          `Error while accepting confirmation for ${id}: ${err.message}${
            err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
          }`
        );
      });
  }

  removeTrade(id: string): Promise<TradeOffer> {
    this.logger.debug('Removing trade offer #' + id + '...');

    return new Promise<TradeOffer>((resolve, reject) => {
      this.manager.getOffer(id, (err, offer) => {
        if (err) {
          if (err.message === 'NoMatch') {
            return reject(new BadRequestException('Trade offer not found'));
          }

          return reject(err);
        }

        if (
          offer.state === SteamTradeOfferManager.ETradeOfferState.Active &&
          offer.state !==
            SteamTradeOfferManager.ETradeOfferState.CreatedNeedsConfirmation
        ) {
          return reject(new BadRequestException('Offer is not active'));
        }

        offer.cancel((err) => {
          if (err) {
            if (
              err.message ===
              `Offer #${offer.id} is not active, so it may not be cancelled or declined`
            ) {
              return reject(new BadRequestException('Offer is not active'));
            } else if (err.eresult !== undefined) {
              return reject(new EResultException(err.message, err.eresult));
            }

            return reject(err);
          }

          return resolve(this.mapOffer(offer));
        });
      });
    })
      .then((offer) => {
        this.logger.debug('Removed trade offer #' + id);
        return offer;
      })
      .catch((err) => {
        this.logger.error(
          `Error while removing trade offer #${id}: ${err.message}${
            err.eresult !== undefined ? ` (eresult: ${err.eresult})` : ''
          }`
        );
        throw err;
      });
  }

  private mapOffer(offer: SteamTradeOfferManager.TradeOffer): TradeOffer {
    return {
      partner: offer.partner.getSteamID64(),
      id: offer.id,
      message: offer.message,
      state: offer.state,
      itemsToGive: offer.itemsToGive,
      itemsToReceive: offer.itemsToReceive,
      isGlitched: offer.isGlitched(),
      isOurOffer: offer.isOurOffer,
      createdAt: Math.floor(offer.created.getTime() / 1000),
      updatedAt: Math.floor(offer.updated.getTime() / 1000),
      expiresAt: Math.floor(offer.expires.getTime() / 1000),
      tradeID: offer.tradeID,
      fromRealTimeTrade: offer.fromRealTimeTrade,
      confirmationMethod: offer.confirmationMethod,
      escrowEndsAt:
        offer.escrowEnds === null
          ? null
          : Math.floor(offer.escrowEnds.getTime() / 1000),
    };
  }
}
