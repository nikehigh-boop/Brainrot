import { Redis } from '@upstash/redis';
import { env } from './env.js';

const url = env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
const token = env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');

export const redis = url && token ? new Redis({ url, token }) : null;
