/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRabbit } from 'src/decorators/rabbitmq.decorator';
import { ChannelWrapper } from 'amqp-connection-manager';
import { RabbitMQManager } from 'src/rabbitmq/rabbitmq.provider';
import { IEmailJob } from '../rabbitmq.interfaces';
import { priorityMap } from '../rabbitmq.constants';
import { envConfig } from 'src/config/env.config';
import { Options } from 'amqplib';

@Injectable()
export class EmailQueueProducer implements OnModuleInit {
  private channel: ChannelWrapper | null = null;
  private readonly queueName = 'email_queue';

  constructor(
    @InjectRabbit()
    private readonly rabbit: RabbitMQManager,
  ) {}

  onModuleInit() {
    this.channel = this.rabbit.getChannel('email-producer');

    if (!this.channel) {
      console.error('❌ Failed to initialize email-producer channel');
      return;
    }

    console.log(`⚙️ Setting up DLQ for ${this.queueName}…`);

    // Producer is the ONLY place where queue topology should be asserted
    void this.rabbit.setupDLQQueues(this.queueName, undefined, undefined, {
      'x-max-priority': 10,
    });

    console.log(`📦 EmailQueueProducer ready → ${this.queueName}`);
  }

  private async enqueue(job: IEmailJob): Promise<void> {
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

      console.log(`📨 Email job enqueued → ${job.type}`);
    } catch (err) {
      console.error(`❌ Failed to enqueue email job "${job.type}"`, err);
    }
  }

  // Public methods (void on purpose)
  enqueueOTPEmail(to: string, otp: number): void {
    void this.enqueue({
      type: 'OTP',
      to,
      subject: 'Confirmation code for email verification!',
      html: `<p>Your verification OTP: ${otp}</p>`,
    });
  }

  enqueueResetPasswordEmail(to: string, otp: number): void {
    void this.enqueue({
      type: 'RESET_PASSWORD',
      to,
      subject: 'Your OTP for password reset',
      html: `<p>Your reset OTP: ${otp}</p>`,
    });
  }

  enqueueWelcomeEmail(to: string, name?: string): void {
    void this.enqueue({
      type: 'WELCOME',
      to,
      subject: 'Welcome to our platform',
      html: `
        <p>Hello ${name}</p>
        <h2>Welcome to ${envConfig.application_name}</h2>
        <p>We're glad to have you 🎉</p>
      `,
    });
  }

  enqueueInvoiceEmail(to: string, invoiceData: Record<string, any>): void {
    void this.enqueue({
      type: 'INVOICE',
      to,
      subject: 'Your invoice',
      html: JSON.stringify(invoiceData),
    });
  }

  enqueueOrderEmail(to: string, orderData: Record<string, any>): void {
    void this.enqueue({
      type: 'ORDER',
      to,
      subject: 'Your Order',
      html: JSON.stringify(orderData),
    });
  }
}
