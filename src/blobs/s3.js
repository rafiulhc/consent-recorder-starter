'use strict';
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

/**
 * Stores recordings in a private S3 bucket with server-side encryption.
 * Recordings are streamed through the app, never exposed as public or pre-signed URLs.
 */
class S3BlobStore {
  constructor(bucket, region, { client } = {}) {
    this.bucket = bucket;
    this.client = client || new S3Client({ region });
  }

  async put(key, body) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
      ServerSideEncryption: 'AES256',
      IfNoneMatch: '*', // never overwrite: recordings are evidence
    }));
  }

  async get(key) {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (err) {
      if (err.name === 'NoSuchKey') return null;
      throw err;
    }
  }

  async delete(key) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

module.exports = { S3BlobStore };
