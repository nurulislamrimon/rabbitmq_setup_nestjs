import { IEmailJobType, IOtherJobType } from './rabbitmq.interfaces';

export const priorityMap: Record<IEmailJobType & IOtherJobType, number> = {
  // mail
  OTP: 10,
  RESET_PASSWORD: 10,
  INVOICE: 7,
  ORDER: 7,
  WELCOME: 5,
  GENERIC: 1,
  NEWSLETTER: 0,

  // visitor sync
  SYNC_VISITOR: 0,
};
