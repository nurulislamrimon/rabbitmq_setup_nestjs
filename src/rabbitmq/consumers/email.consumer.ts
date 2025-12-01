import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectRabbit } from 'src/decorators/rabbitmq.decorator';
import { RabbitMQManager } from 'src/rabbitmq/rabbitmq.provider';
import { IEmailJob } from '../rabbitmq.interfaces';
import { envConfig } from 'src/config/env.config';

@Injectable()
export class EmailConsumer implements OnModuleInit {
  private readonly queueName = 'email_queue';

  constructor(
    @InjectRabbit() private readonly rabbit: RabbitMQManager,
    private readonly mailService: MailService,
  ) {}

  async onModuleInit() {
    console.log('📨 Setting up EmailConsumer…');

    const dlqConfig = {
      baseQueue: this.queueName,
      retryQueue: `${this.queueName}_retry`,
      dlqQueue: `${this.queueName}_dlq`,
      maxRetries: 3,
    };

    // DO NOT assert the queue here → avoids 406 errors
    await this.rabbit.consume<IEmailJob>(
      this.queueName,
      async (job) => await this.process(job),
      {
        prefetch: 1,
        dlq: dlqConfig,
      },
    );

    console.log('📥 EmailConsumer started');
  }

  private async process(job: IEmailJob): Promise<void> {
    try {
      await this.mailService.send({
        to: job.to,
        subject: job.subject || `Email From ${envConfig.application_name}`,
        html: job.html,
      });

      console.log(`✅ Email sent → ${job.type}`);
    } catch (err) {
      console.error(`❌ Failed sending email (${job.type})`, err);

      // Throw error → RabbitMQManager handles retry or DLQ
      throw err;
    }
  }
}
