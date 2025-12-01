import { Inject } from '@nestjs/common';
import { RABBIT } from 'src/rabbitmq/rabbitmq.provider';

export const InjectRabbit = () => Inject(RABBIT);
