import { describe, expect, test } from 'bun:test';
import { presignUrl, signedHeaders, UNSIGNED_PAYLOAD, uriEncode } from './sigv4';

// AWS's published examples (the SigV4 test suite's get-vanilla, S3's presigned GET).
const SUITE = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const S3_DOCS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

describe('SigV4', () => {
  test("headers: the test suite's get-vanilla", () => {
    const headers = signedHeaders(
      { method: 'GET', url: new URL('https://example.amazonaws.com/'), headers: {}, body: '' },
      {
        service: 'service',
        region: 'us-east-1',
        keys: SUITE,
        now: new Date('2015-08-30T12:36:00Z'),
      },
    );

    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
    expect(headers['x-amz-date']).toBe('20150830T123600Z');
  });

  test("a query string: S3's presigned GET example", () => {
    const url = presignUrl(
      new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      { service: 's3', region: 'us-east-1', keys: S3_DOCS, now: new Date('2013-05-24T00:00:00Z') },
      86400,
      UNSIGNED_PAYLOAD,
    );

    expect(new URL(url).searchParams.get('X-Amz-Signature')).toBe(
      'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  // The aws CLI's own botocore (SigV4QueryAuth, as `ec2-instance-connect open-tunnel` signs) made
  // this signature with these keys: the empty body's hash, never UNSIGNED-PAYLOAD.
  test("openTunnel's URL: botocore's signature, its own parameters and the session's token", () => {
    const url = new URL(
      presignUrl(
        new URL(
          'wss://eice-1.ec2-instance-connect-endpoint.eu-west-1.amazonaws.com/openTunnel?instanceConnectEndpointId=eice-1&remotePort=22&privateIpAddress=10.0.0.5',
        ),
        {
          service: 'ec2-instance-connect',
          region: 'eu-west-1',
          keys: { ...SUITE, sessionToken: 'tok/en+=' },
          now: new Date('2026-10-23T11:00:00Z'),
        },
        60,
      ),
    );

    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/openTunnel');
    expect(url.searchParams.get('privateIpAddress')).toBe('10.0.0.5');
    expect(url.searchParams.get('X-Amz-Security-Token')).toBe('tok/en+=');
    expect(url.searchParams.get('X-Amz-Credential')).toBe(
      'AKIDEXAMPLE/20261023/eu-west-1/ec2-instance-connect/aws4_request',
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(url.searchParams.get('X-Amz-Signature')).toBe(
      '8ed4b9f432792bd4a3881622c0adeff7c14aeb277d991f24976f435dd4e2ba4d',
    );
  });

  test('encodes as RFC 3986 wants', () => {
    expect(uriEncode("a b!'()*~/+=")).toBe('a%20b%21%27%28%29%2A~%2F%2B%3D');
  });
});
