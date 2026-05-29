import { Hono } from 'hono';
import { rawQuery } from '../db/client.js';
import { Redis } from 'ioredis';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';

const health = new Hono();

health.get('/health', async (c) => {
  let pgOk = false;
  let redisOk = false;
  let minioOk = false;

  // Postgres
  try {
    const rows = await rawQuery('SELECT 1 AS ok');
    pgOk = rows[0]?.ok === 1;
  } catch { /* skip */ }

  // Redis
  try {
    const redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT) || 6379,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
    });
    await redis.connect();
    const pong = await redis.ping();
    redisOk = pong === 'PONG';
    await redis.quit();
  } catch { /* skip */ }

  // MinIO
  try {
    const s3 = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT || 'http://localhost:9000',
      region: 'us-east-1',
      credentials: {
        accessKeyId: process.env.MINIO_ROOT_USER || 'minioadmin',
        secretAccessKey: process.env.MINIO_ROOT_PASSWORD || 'minioadmin',
      },
      forcePathStyle: true,
    });
    await s3.send(new HeadBucketCommand({
      Bucket: process.env.MINIO_BUCKET || 'fce-media',
    }));
    minioOk = true;
    s3.destroy();
  } catch { /* skip */ }

  const allOk = pgOk && redisOk && minioOk;

  return c.json({
    status: allOk ? 'ok' : 'degraded',
    service: 'fce-api',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
    checks: {
      postgres: pgOk ? 'ok' : 'error',
      redis: redisOk ? 'ok' : 'error',
      minio: minioOk ? 'ok' : 'error',
    },
  });
});

export default health;
