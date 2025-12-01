import { Global, Module } from '@nestjs/common';
import { RabbitMQProvider } from './rabbitmq.provider';
import { EmailConsumer } from './consumers/email.consumer';
import { EmailQueueProducer } from './producers/email-queue.producer';
import { VisitorModule } from 'src/v1/visitor/visitor.module';
import { VisitorSyncSchedulerProducer } from './producers/visitor-scheduler.producer';
import { VisitorSyncSchedulerConsumer } from './consumers/visitor-scheduler.consumer';
import { VisitorSyncQueueProducer } from './producers/visitor-queue.producer';
import { VisitorSyncQueueConsumer } from './consumers/visitor-queue.consumer';

@Global()
@Module({
  imports: [VisitorModule],
  providers: [
    RabbitMQProvider,
    EmailQueueProducer,
    EmailConsumer,
    VisitorSyncSchedulerProducer,
    VisitorSyncSchedulerConsumer,
    VisitorSyncQueueProducer,
    VisitorSyncQueueConsumer,
  ],
  exports: [
    RabbitMQProvider,
    EmailQueueProducer,
    EmailConsumer,
    VisitorSyncSchedulerProducer,
    VisitorSyncSchedulerConsumer,
    VisitorSyncQueueProducer,
    VisitorSyncQueueConsumer,
  ],
})
export class RabbitMQModule {}
