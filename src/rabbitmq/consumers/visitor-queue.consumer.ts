/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRabbit } from 'src/decorators/rabbitmq.decorator';
import { RabbitMQManager } from 'src/rabbitmq/rabbitmq.provider';
import { Visitor } from '@prisma/client';
import { IOtherJobType } from '../rabbitmq.interfaces';
import { VisitorService } from 'src/v1/visitor/visitor.service';
import { envConfig } from 'src/config/env.config';

@Injectable()
export class VisitorSyncQueueConsumer implements OnModuleInit {
  private readonly queueName = 'visitor_sync_queue';
  private readonly DELAY = envConfig.schedule_time;
  private schedulerGroup: Awaited<
    ReturnType<RabbitMQManager['createExchangeGroup']>
  > | null = null;

  constructor(
    @InjectRabbit() private readonly rabbit: RabbitMQManager,
    private readonly visitorService: VisitorService,
  ) {}

  async onModuleInit() {
    console.log('📨 Setting up VisitorSyncConsumer…');

    // ------------------------------
    // Create the SAME scheduler group
    // ------------------------------
    this.schedulerGroup = await this.rabbit.createExchangeGroup(
      'visitor_sync_scheduler',
      'visitor.sync.tick',
      this.DELAY,
    );

    if (!this.schedulerGroup) {
      console.error('❌ Failed to init scheduler exchange-group');
      return;
    }

    const group = this.schedulerGroup;

    // Ensure the exchanges exist (safe)
    await this.rabbit.waitForExchange(group.mainExchange);
    await this.rabbit.waitForExchange(group.delayExchange);

    // ------------------------------
    // DLQ config for this consumer
    // ------------------------------
    const dlqConfig = {
      baseQueue: this.queueName,
      retryQueue: `${this.queueName}_retry`,
      dlqQueue: `${this.queueName}_dlq`,
      maxRetries: 3,
    };

    await this.rabbit.consume(
      this.queueName,
      async (job) => await this.process(job),
      {
        prefetch: 1,
        dlq: dlqConfig,
      },
    );

    console.log('📥 VisitorSyncConsumer started');
  }

  private async process(job: {
    type: IOtherJobType;
    payload: (Visitor & { count: number })[];
  }): Promise<void> {
    const group = this.schedulerGroup!;
    try {
      await this.visitorService.upsertBatchIntoDB(job.payload);

      console.log(`VisitorSync sent → to the batch upsert`);

      // -----------------------------------
      // RESCHEDULE next tick after sync
      // -----------------------------------
      await this.rabbit.scheduleMessage({
        exchange: group.delayExchange,
        routingKey: group.routingKey,
        payload: { tick: true },
        delay: this.DELAY,
      });

      console.log(`⏳ Next tick scheduled in ${this.DELAY}ms`);
    } catch (err) {
      console.error(`❌ Failed sending visitor-sync (${job.type})`, err);
      throw err;
    }
  }
}
