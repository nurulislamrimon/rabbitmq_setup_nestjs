export const rabbitMQConfig = {
  url: process.env.RABBITMQ_URL || 'amqp://localhost',

  // Heartbeat + reconnect strategy
  heartbeatInterval: parseInt(
    process.env.RABBITMQ_HEARTBEAT_INTERVAL || '5',
    10,
  ),
  reconnectTime: parseInt(process.env.RABBITMQ_RECONNECT_TIME || '5', 10),

  // Prefetch for consumers (default concurrency)
  prefetch: parseInt(process.env.RABBITMQ_PREFETCH || '10', 10),

  // DLQ + retries
  dlq: {
    maxRetries: parseInt(process.env.RABBITMQ_DLQ_MAX_RETRIES || '3', 10),
    retryDelay: parseInt(process.env.RABBITMQ_DLQ_RETRY_DELAY || '10000', 10),
  },

  // Delayed messages plugin support
  delay: {
    usePlugin: (process.env.RABBITMQ_DELAY_PLUGIN || 'true') === 'true',
    defaultDelay: parseInt(process.env.RABBITMQ_DEFAULT_DELAY || '10000', 10),
  },
};
