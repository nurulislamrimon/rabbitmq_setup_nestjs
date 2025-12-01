import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRabbit } from 'src/decorators/rabbitmq.decorator';
import { RabbitMQManager } from 'src/rabbitmq/rabbitmq.provider';
import { IRabbitGroup } from '../rabbitmq.interfaces';
import { VisitorService } from 'src/v1/visitor/visitor.service';
import { envConfig } from 'src/config/env.config';

@Injectable()
export class VisitorSyncSchedulerConsumer implements OnModuleInit {
  private readonly BASE = 'visitor_sync_scheduler';
  private readonly DELAY = envConfig.schedule_time;

  private group: IRabbitGroup | null = null;

  constructor(
    @InjectRabbit() private readonly rabbit: RabbitMQManager,
    private readonly visitorService: VisitorService,
  ) {}

  async onModuleInit() {
    console.log('⚙️ Starting VisitorSyncSchedulerConsumer…');

    // Create the exchange group (safe)
    this.group = await this.rabbit.createExchangeGroup(
      this.BASE,
      'visitor.sync.tick',
      this.DELAY,
    );

    if (!this.group) {
      console.error('❌ Failed to initialize scheduler topology');
      return;
    }

    // TS-safe reference — prevents "possibly null" errors
    const group = this.group;

    // Wait only for exchanges (safe: no queue asserts)
    await this.rabbit.waitForExchange(group.mainExchange);
    await this.rabbit.waitForExchange(group.delayExchange);

    // Consume ticks
    await this.rabbit.consume(
      group.mainQueue,
      async () => {
        await this.visitorService.enqueueVisitorsBatch();
      },
      { prefetch: 1 },
    );

    console.log('📥 Visitor Sync Scheduler Consumer ready');
  }
}
