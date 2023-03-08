import { RedisModule } from '@liaoliaots/nestjs-redis';
import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { HeartbeatsModule } from '../heartbeats/heartbeats.module';
import { InventoriesController } from './inventories.controller';
import { InventoriesService } from './inventories.service';

@Module({
  imports: [RedisModule, HttpModule, HeartbeatsModule],
  controllers: [InventoriesController],
  providers: [InventoriesService],
})
export class InventoriesModule {}