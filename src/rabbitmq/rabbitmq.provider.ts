/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */

import { Injectable, OnModuleDestroy, Provider } from '@nestjs/common';
import * as amqp from 'amqp-connection-manager';
import { AmqpConnectionManager, ChannelWrapper } from 'amqp-connection-manager';
import { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { rabbitMQConfig } from './rabbitmq.conf';
import { IDLQSetup, IExchangeGroup } from './rabbitmq.interfaces';

export const RABBIT = 'RABBITMQ_MANAGER';

@Injectable()
export class RabbitMQManager implements OnModuleDestroy {
  private connection: AmqpConnectionManager | null = null;
  private readonly channels: Record<string, ChannelWrapper> = {};
  private adminChannel: ChannelWrapper | null = null;
  private readonly config = rabbitMQConfig;

  // Used to avoid processing new messages during shutdown
  private shuttingDown = false;

  // ---------- CONNECTION (LAZY + AUTO-RECONNECT) ----------

  private getConnection(): AmqpConnectionManager {
    if (!this.connection) {
      console.warn('Initializing RabbitMQ connection lazily...');

      this.connection = amqp.connect([this.config.url], {
        heartbeatIntervalInSeconds: this.config.heartbeatInterval,
        reconnectTimeInSeconds: this.config.reconnectTime,
      });

      this.connection.on('connect', () => {
        console.log('🐇 RabbitMQ connected');
      });

      this.connection.on('disconnect', (err) => {
        console.log('❌ RabbitMQ disconnected', err?.err?.message);
      });
    }

    return this.connection;
  }

  // ---------- CHANNEL HELPERS (AUTO-CLEANUP) ----------

  private createNamedChannel(
    name: string,
    setup?: (ch: ConfirmChannel) => Promise<void>,
  ): ChannelWrapper {
    const conn = this.getConnection();

    const wrapper = conn.createChannel({
      setup: setup
        ? (channel: ConfirmChannel) => setup(channel)
        : () => Promise.resolve(),
    });

    wrapper.on('error', (err) => {
      console.error(`⚠️ Channel "${name}" error`, err?.message);
    });

    wrapper.on('close', () => {
      console.warn(`⚠️ Channel "${name}" closed — removing from cache`);
      delete this.channels[name];
    });

    return wrapper;
  }

  public getChannel(name: string): ChannelWrapper | null {
    try {
      if (!this.channels[name]) {
        console.log(`📡 Creating channel: ${name}`);
        this.channels[name] = this.createNamedChannel(name);
      }
      return this.channels[name];
    } catch (err) {
      console.warn(`⚠️ Cannot create channel "${name}" — Rabbit offline`, err);
      return null;
    }
  }

  private getAdminChannel(): ChannelWrapper | null {
    try {
      if (!this.adminChannel) {
        console.log('📡 Creating admin channel');
        const conn = this.getConnection();
        const wrapper = conn.createChannel({
          setup: () => Promise.resolve(),
        });

        wrapper.on('error', (err) =>
          console.error('⚠️ Admin channel error', err?.message),
        );
        wrapper.on('close', () => {
          console.warn('⚠️ Admin channel closed — resetting');
          this.adminChannel = null;
        });

        this.adminChannel = wrapper;
      }

      return this.adminChannel;
    } catch (err) {
      console.warn('⚠️ Cannot create admin channel — Rabbit offline', err);
      return null;
    }
  }

  // ---------- lock the queue ----------

  public async acquireSchedulerLock(lockQueue: string): Promise<boolean> {
    const ch = this.getChannel(`lock:${lockQueue}`);
    if (!ch) return false;

    try {
      await ch.addSetup((c) =>
        c.assertQueue(lockQueue, {
          exclusive: true,
          durable: false,
          autoDelete: true,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  // ---------- ADMIN: EXCHANGES / QUEUES / BINDINGS ----------

  public async assertExchange(
    exchange: string,
    type: string = 'direct',
    options?: Options.AssertExchange,
  ): Promise<void> {
    try {
      const ch = this.getAdminChannel();
      if (!ch) return;

      await ch.addSetup((c: ConfirmChannel) =>
        c.assertExchange(exchange, type, { durable: true, ...options }),
      );
    } catch (e) {
      console.error(`❌ assertExchange(${exchange}) failed`, e);
    }
  }

  // Normal queue assert. If args mismatch existing queue, it logs and skips
  public async assertQueue(
    queue: string,
    options?: Options.AssertQueue,
  ): Promise<void> {
    try {
      const ch = this.getAdminChannel();
      if (!ch) return;

      await ch.addSetup(async (c: ConfirmChannel) => {
        try {
          await c.assertQueue(queue, { durable: true, ...options });
        } catch (err: any) {
          if (err?.code === 406) {
            console.warn(
              `⚠️ assertQueue(${queue}) skipped — queue already exists with different args`,
            );
          } else {
            console.error(`❌ assertQueue(${queue}) failed`, err);
          }
        }
      });
    } catch (e) {
      console.error(`❌ assertQueue(${queue}) failed (admin)`, e);
    }
  }

  public async bindQueue(
    queue: string,
    exchange: string,
    routingKey: string,
  ): Promise<void> {
    try {
      const ch = this.getAdminChannel();
      if (!ch) return;

      await ch.addSetup((c: ConfirmChannel) =>
        c.bindQueue(queue, exchange, routingKey),
      );
    } catch (e) {
      console.error(`❌ bindQueue(${queue}, ${exchange}) failed`, e);
    }
  }

  public async purgeQueue(queue: string): Promise<void> {
    try {
      const ch = this.getAdminChannel();
      if (!ch) return;
      await ch.addSetup((c) => c.purgeQueue(queue));
      console.log(`🧹 Purged queue: ${queue}`);
    } catch (err) {
      console.warn(`⚠️ Could not purge queue ${queue}`, err);
    }
  }

  public waitForExchange(exchange: string): Promise<void> {
    return new Promise((res) => {
      setTimeout(() => {
        void (async () => {
          await this.assertExchange(exchange);
          res();
        })();
      }, 50);
    });
  }

  public waitForQueue(queue: string): Promise<void> {
    return new Promise((res) => {
      setTimeout(() => {
        void (async () => {
          await this.assertQueue(queue);
          res();
        })();
      }, 50);
    });
  }

  // x-delayed-message exchange for plugin-based delays.
  public async assertDelayedExchange(
    exchange: string,
    delayedType: 'direct' | 'topic' | 'fanout' = 'direct',
  ): Promise<void> {
    try {
      const ch = this.getAdminChannel();
      if (!ch) return;

      await ch.addSetup((c: ConfirmChannel) =>
        c.assertExchange(exchange, 'x-delayed-message', {
          durable: true,
          arguments: {
            'x-delayed-type': delayedType,
          },
        }),
      );
    } catch (e) {
      console.error(`❌ assertDelayedExchange(${exchange}) failed`, e);
    }
  }

  // ---------- DLQ + RETRY (WITH MAX RETRIES) ----------
  public setupDLQQueues(
    baseQueue: string,
    maxRetries: number = this.config.dlq.maxRetries,
    retryDelay: number = this.config.dlq.retryDelay,
    extraArgs: Record<string, any> = {},
  ): IDLQSetup | null {
    const retryQueue = `${baseQueue}_retry`;
    const dlqQueue = `${baseQueue}_dlq`;

    try {
      const channel = this.getConnection().createChannel();

      void channel.addSetup(async (ch: ConfirmChannel) => {
        console.log(`DLQ setup for "${baseQueue}"`);

        // main queue -> retry queue on failure
        await ch.assertQueue(baseQueue, {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': retryQueue,
            ...extraArgs,
          },
        });

        // retry queue -> main queue after delay
        await ch.assertQueue(retryQueue, {
          durable: true,
          arguments: {
            'x-message-ttl': retryDelay,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': baseQueue,
          },
        });

        // DLQ queue (terminal)
        await ch.assertQueue(dlqQueue, { durable: true });
      });

      return { baseQueue, retryQueue, dlqQueue, maxRetries };
    } catch {
      return null;
    }
  }

  // ---------- REUSABLE EXCHANGE GROUP (TTL-BASED DELAY) ----------
  public async createExchangeGroup(
    base: string,
    routingKey: string = base,
    delay: number = 10_000,
  ): Promise<IExchangeGroup | null> {
    const ex = `${base}.exchange`;
    const delayEx = `${base}.delay.exchange`;
    const q = `${base}.queue`;
    const delayQ = `${base}.delay.queue`;

    try {
      const conn = this.getConnection();
      const chWrapper = conn.createChannel();

      return await new Promise<IExchangeGroup>((resolve, reject) => {
        void chWrapper.addSetup(async (c: ConfirmChannel) => {
          try {
            console.log(`🔥 Exchange group ready: ${base}`);

            await c.assertExchange(ex, 'direct', { durable: true });
            await c.assertExchange(delayEx, 'direct', { durable: true });

            await c.assertQueue(q, { durable: true });
            await c.assertQueue(delayQ, {
              durable: true,
              arguments: {
                'x-message-ttl': delay,
                'x-dead-letter-exchange': ex,
                'x-dead-letter-routing-key': routingKey,
              },
            });

            await c.bindQueue(q, ex, routingKey);
            await c.bindQueue(delayQ, delayEx, routingKey);

            resolve({
              mainExchange: ex,
              delayExchange: delayEx,
              mainQueue: q,
              delayQueue: delayQ,
              routingKey,
            });
          } catch (err) {
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(err);
          }
        });
      });
    } catch (err) {
      console.warn(`⚠️ createExchangeGroup(${base}) failed`, err);
      return null;
    }
  }

  // ---------- GENERIC PUBLISH (WITH CONFIRMS) ----------
  public async publish(
    exchange: string,
    routingKey: string,
    payload: unknown,
    options: Options.Publish = {},
  ): Promise<boolean> {
    try {
      const ch = this.getChannel('publisher');
      if (!ch) return false;

      const buffer = Buffer.from(JSON.stringify(payload));

      await ch.waitForConnect();

      await ch.publish(exchange, routingKey, buffer, {
        persistent: true,
        ...options,
      });

      return true;
    } catch (err) {
      console.warn('⚠️ publish() failed — Rabbit offline?', err);
      return false;
    }
  }

  // ---------- SCHEDULE MESSAGE (PLUGIN OR TTL, WITH CONFIRMS) ----------

  public async scheduleMessage({
    exchange,
    routingKey,
    payload,
    delay,
    usePlugin = this.config.delay?.usePlugin ?? true,
    headers: extraHeaders,
  }: {
    exchange: string;
    routingKey: string;
    payload: unknown;
    delay: number;
    usePlugin?: boolean;
    headers?: Options.Publish['headers'];
  }): Promise<void> {
    try {
      const ch = this.getChannel('scheduler');
      if (!ch) return;

      const buffer = Buffer.from(JSON.stringify(payload));
      const headers = usePlugin
        ? { ...(extraHeaders ?? {}), 'x-delay': delay }
        : extraHeaders;

      await ch.waitForConnect();

      await ch.publish(exchange, routingKey, buffer, {
        persistent: true,
        headers,
      } as any);

      console.log(
        `⏱ Scheduled job to "${exchange}" with routingKey="${routingKey}" (${delay}ms, plugin=${usePlugin})`,
      );
    } catch (err) {
      console.warn('⚠️ scheduleMessage() failed — Rabbit offline?', err);
    }
  }

  // ---------- CONSUMER HELPER (WITH RETRIES + DLQ + SHUTDOWN AWARE) ----------
  public async consume<T = any>(
    queue: string,
    handler: (
      payload: T,
      raw: ConsumeMessage,
      channel: ConfirmChannel,
    ) => Promise<void>,
    options?: { prefetch?: number; dlq?: IDLQSetup | null },
  ): Promise<void> {
    try {
      const chWrapper = this.getChannel(`consumer:${queue}`);
      if (!chWrapper) return;

      await chWrapper.addSetup(async (ch: ConfirmChannel) => {
        const prefetch = options?.prefetch ?? this.config.prefetch ?? 10;
        ch.prefetch(prefetch);

        console.log(`📥 Consuming from "${queue}" (prefetch=${prefetch})`);

        const dlq = options?.dlq;

        await ch.consume(queue, async (msg) => {
          if (!msg) return;

          // If app is shutting down, requeue message and do nothing
          if (this.shuttingDown) {
            ch.nack(msg, false, true);
            return;
          }

          const headers = msg.properties.headers ?? {};
          const retryCount = Number(headers['x-retries'] ?? 0);

          try {
            const payload = JSON.parse(msg.content.toString()) as T;

            await handler(payload, msg, ch);
            ch.ack(msg);
          } catch (err) {
            console.error(`❌ Error handling message from ${queue}:`, err);

            if (!dlq) {
              // no DLQ configured → do not retry
              ch.nack(msg, false, false);
              return;
            }

            const nextRetry = retryCount + 1;

            if (nextRetry > dlq.maxRetries) {
              console.log(
                `💀 Max retries reached → sending to DLQ ${dlq.dlqQueue}`,
              );

              ch.sendToQueue(dlq.dlqQueue, msg.content, {
                persistent: true,
                headers: {
                  ...headers,
                  'x-retries': nextRetry,
                },
              });

              ch.ack(msg);
              return;
            }

            console.log(
              `🔁 Retry ${nextRetry}/${dlq.maxRetries} → sending to retry queue ${dlq.retryQueue}`,
            );

            ch.sendToQueue(dlq.retryQueue, msg.content, {
              persistent: true,
              headers: {
                ...headers,
                'x-retries': nextRetry,
              },
            });

            ch.ack(msg);
          }
        });
      });
    } catch (err) {
      console.warn(`⚠️ consume(${queue}) failed`, err);
    }
  }

  // ---------- NEST LIFECYCLE ----------

  async onModuleDestroy() {
    this.shuttingDown = true;

    try {
      const channelValues = Object.values(this.channels);

      // Close all named channels (this also cancels consumers)
      await Promise.all(
        channelValues.map((ch) =>
          ch
            .close()
            .catch((err) =>
              console.warn('⚠️ Error closing channel on shutdown', err),
            ),
        ),
      );

      if (this.adminChannel) {
        await this.adminChannel
          .close()
          .catch((err) =>
            console.warn('⚠️ Error closing admin channel on shutdown', err),
          );
      }

      if (this.connection) {
        await this.connection.close();
      }

      console.log('🛑 RabbitMQ connection closed');
    } catch (err) {
      console.warn('⚠️ Error during RabbitMQ shutdown', err);
    }
  }
}

export const RabbitMQProvider: Provider = {
  provide: RABBIT,
  useClass: RabbitMQManager,
};
