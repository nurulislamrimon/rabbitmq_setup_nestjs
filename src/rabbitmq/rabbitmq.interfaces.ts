export type IEmailJobType =
  | 'WELCOME'
  | 'OTP'
  | 'RESET_PASSWORD'
  | 'INVOICE'
  | 'GENERIC'
  | 'ORDER'
  | 'NEWSLETTER';

export type IOtherJobType = 'VISITOR_SYNC';

export interface IEmailJob {
  type: IEmailJobType;
  to: string;
  subject?: string;
  template?: string;
  html: string;
  attatchments?: IEmailAttatchments[];
}

export interface IEmailAttatchments {
  filename: string;
  path: string;
}

export interface IExchangeGroup {
  mainExchange: string;
  delayExchange: string;
  mainQueue: string;
  delayQueue: string;
  routingKey: string;
}

export interface IDLQSetup {
  baseQueue: string;
  retryQueue: string;
  dlqQueue: string;
  maxRetries: number;
}

export interface IRabbitGroup {
  mainExchange: string;
  delayExchange: string;
  mainQueue: string;
  delayQueue: string;
  routingKey: string;
}
