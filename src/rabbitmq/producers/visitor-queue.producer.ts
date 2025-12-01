/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRabbit } from 'src/decorators/rabbitmq.decorator';
import { ChannelWrapper } from 'amqp-connection-manager';
import { RabbitMQManager } from 'src/rabbitmq/rabbitmq.provider';
import { IOtherJobType } from '../rabbitmq.interfaces';
import { priorityMap } from '../rabbitmq.constants';
import { Options } from 'amqplib';

@Injectable()
export class VisitorSyncQueueProducer implements OnModuleInit {
  private channel: ChannelWrapper | null = null;
  private readonly queueName = 'visitor_sync_queue';

  constructor(
    @InjectRabbit()
    private readonly rabbit: RabbitMQManager,
  ) {}

  onModuleInit() {
    this.channel = this.rabbit.getChannel('visitor-sync-producer');

    if (!this.channel) {
      console.error('❌ Failed to initialize visitor-sync-producer channel');
      return;
    }

    console.log(`⚙️ Setting up DLQ for ${this.queueName}…`);

    // Producer is the ONLY place where queue topology should be asserted
    void this.rabbit.setupDLQQueues(this.queueName, undefined, undefined, {
      'x-max-priority': 10,
    });

    console.log(`📦 VisitorSyncQueueProducer ready → ${this.queueName}`);
  }

  private async enqueue(job: {
    type: IOtherJobType;
    payload: Record<string, unknown>[];
  }): Promise<void> {
    if (!this.channel) {
      console.warn('❌ Cannot enqueue job: channel unavailable');
      return;
    }

    const buffer = Buffer.from(JSON.stringify(job));

    const options: Options.Publish = {
      contentType: 'application/json',
      persistent: true,
      priority: priorityMap[job.type] ?? 0,
    };

    try {
      await this.channel.waitForConnect();

      await this.channel.sendToQueue(this.queueName, buffer, options as any);

      console.log(`📨 VisitorSync job enqueued → ${job.type}`);
    } catch (err) {
      console.error(`❌ Failed to enqueue visitor-sync job "${job.type}"`, err);
    }
  }

  // Public methods (void on purpose)
  async enqueueVisitorSync(payload: Record<string, unknown>[]) {
    await this.enqueue({
      type: 'VISITOR_SYNC',
      payload,
    });
  }
}
