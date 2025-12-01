import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRabbit } from 'src/decorators/rabbitmq.decorator';
import { RabbitMQManager } from 'src/rabbitmq/rabbitmq.provider';
import { IRabbitGroup } from '../rabbitmq.interfaces';
import { envConfig } from 'src/config/env.config';

@Injectable()
export class VisitorSyncSchedulerProducer implements OnModuleInit {
  private readonly BASE = 'visitor_sync_scheduler';
  private readonly ROUTE = 'visitor.sync.tick';
  private readonly DELAY_MS = envConfig.schedule_time;

  private group: IRabbitGroup | null = null;

  constructor(@InjectRabbit() private readonly rabbit: RabbitMQManager) {}

  async onModuleInit() {
    console.log('⚙️ Setting up VisitorSyncSchedulerProducer…');

    // -------- LOCK (one instance runs only) --------
    const lock = await this.rabbit.acquireSchedulerLock(
      'visitor_sync_scheduler_lock',
    );

    if (!lock) {
      console.warn('🔒 Scheduler already active → skip');
      return;
    }

    // -------- EXCHANGE/QUEUE GROUP --------
    this.group = await this.rabbit.createExchangeGroup(
      this.BASE,
      this.ROUTE,
      this.DELAY_MS,
    );

    if (!this.group) {
      console.error('❌ Failed to create scheduler exchange group');
      return;
    }

    console.log('⏳ Waiting for RabbitMQ to finalize topology…');

    // Wait for exchanges ONLY (no queue asserts → avoids 406 errors)
    await this.rabbit.waitForExchange(this.group.delayExchange);
    await this.rabbit.waitForExchange(this.group.mainExchange);

    // -------- SAFE PURGE (queues already created by createExchangeGroup) --------
    await this.rabbit.purgeQueue(this.group.mainQueue);
    await this.rabbit.purgeQueue(this.group.delayQueue);

    console.log('🧹 Old ticks cleared');

    // -------- FIRST TICK --------
    await this.rabbit.scheduleMessage({
      exchange: this.group.delayExchange,
      routingKey: this.group.routingKey,
      payload: { tick: true },
      delay: this.DELAY_MS,
    });

    console.log('⏱ First scheduler tick queued');
  }
}
