import { describe, expect, test } from 'bun:test';
import { boardAttachment, cardImageSources, withCardImages } from './card-images';

const ORG = 'https://dev.azure.com/demo-org';
const ATTACHMENT =
  'https://dev.azure.com/demo-org/0f1e2d3c-aaaa-bbbb-cccc-000000000001/_apis/wit/attachments/9b2c6c4e-1111-2222-3333-444455556666?fileName=cart.png';

describe('boardAttachment: only the board org’s own attachments, read from dev.azure.com', () => {
  test.each<[string, string, string | undefined]>([
    ['an attachment of the org', ATTACHMENT, ATTACHMENT],
    ['the org’s name in another case', ATTACHMENT.replace('demo-org', 'Demo-Org'), ATTACHMENT],
    [
      'without the project segment',
      'https://dev.azure.com/demo-org/_apis/wit/attachments/9b2c6c4e?fileName=a.png',
      'https://dev.azure.com/demo-org/_apis/wit/attachments/9b2c6c4e?fileName=a.png',
    ],
    [
      'the org’s visualstudio.com name, read from dev.azure.com',
      'https://demo-org.visualstudio.com/Shop/_apis/wit/attachments/9b2c6c4e?fileName=a.png',
      'https://dev.azure.com/demo-org/Shop/_apis/wit/attachments/9b2c6c4e?fileName=a.png',
    ],
    ['another org', ATTACHMENT.replace('demo-org', 'other-org'), undefined],
    ['another host', 'https://example.com/_apis/wit/attachments/9b2c6c4e', undefined],
    ['not https', ATTACHMENT.replace('https:', 'http:'), undefined],
    ['the org’s other API', 'https://dev.azure.com/demo-org/_apis/connectionData', undefined],
    [
      'a dot-dot path out of the org',
      'https://dev.azure.com/demo-org/../other-org/_apis/wit/attachments/9b2c6c4e',
      undefined,
    ],
    [
      'a host spelled with a user part',
      'https://dev.azure.com@example.com/demo-org/_apis/wit/attachments/9b2c6c4e',
      undefined,
    ],
    ['a fragment', `${ATTACHMENT}#x`, undefined],
    [
      'an encoded dot-dot project segment',
      'https://dev.azure.com/demo-org/%2e%2E/_apis/wit/attachments/9b2c6c4e',
      undefined,
    ],
    [
      'a backslash a URL parser reads as a slash',
      'https://dev.azure.com/demo-org\\..\\x/_apis/wit/attachments/9b2c6c4e',
      undefined,
    ],
    [
      'more path after the id',
      'https://dev.azure.com/demo-org/_apis/wit/attachments/9b2c6c4e/../../x',
      undefined,
    ],
    ['a local file', '/tmp/a.png', undefined],
  ])('%s', (_, src, want) => {
    expect(boardAttachment(ORG, src)).toBe(want);
  });
});

describe('cardImageSources', () => {
  test('each http(s) image once, in order; local ones and links are not', () => {
    const md = [
      `Before ![cart](${ATTACHMENT}) and ![badge](https://img.example/b.svg "Badge")`,
      `![again](${ATTACHMENT}) [a link](https://example.com) ![local](/tmp/x.png)`,
      `![spaced](<https://dev.azure.com/demo-org/_apis/wit/attachments/abc?fileName=a b.png>)`,
    ].join('\n');

    expect(cardImageSources(md)).toEqual([
      ATTACHMENT,
      'https://img.example/b.svg',
      'https://dev.azure.com/demo-org/_apis/wit/attachments/abc?fileName=a b.png',
    ]);
  });
});

describe('withCardImages: a read image as its local file, any other a link', () => {
  test('read, not read, never asked', () => {
    const md = `![cart](${ATTACHMENT})\n\n![](https://img.example/b.svg)\n\n![x](https://dev.azure.com/demo-org/_apis/wit/attachments/c)`;

    expect(
      withCardImages(md, {
        [ATTACHMENT]: '/home/me/Library/Application Support/abe/images/ab12.png',
        'https://img.example/b.svg': null,
      }),
    ).toBe(
      [
        '![cart](file:///home/me/Library/Application%20Support/abe/images/ab12.png)',
        '[image](https://img.example/b.svg)',
        '[x](https://dev.azure.com/demo-org/_apis/wit/attachments/c)',
      ].join('\n\n'),
    );
  });

  test('a local file a card names is a link, never drawn; a kept path is escaped', () => {
    expect(withCardImages('![x](/etc/secret.png) ![](file:///home/me/a.png)', {})).toBe(
      '[x](/etc/secret.png) [image](file:///home/me/a.png)',
    );
    expect(withCardImages(`![a](${ATTACHMENT})`, { [ATTACHMENT]: '/s/im ages/a#1?.png' })).toBe(
      '![a](file:///s/im%20ages/a%231%3F.png)',
    );
  });

  test('an image in a form not read here, or raw <img>, is never drawn either', () => {
    expect(
      withCardImages(
        '![x](/etc/a.png \'title\') ![a]b](/etc/b.png) ![r][ref]\n\n[ref]: /etc/c.png\n\n<IMG src="/etc/d.png">',
        {},
      ),
    ).toBe(
      '!\\[x](/etc/a.png \'title\') !\\[a]b](/etc/b.png) !\\[r][ref]\n\n[ref]: /etc/c.png\n\n&lt;IMG src="/etc/d.png">',
    );
  });

  test('text with no images is as it was', () => {
    expect(withCardImages('**plain** [a](https://x.example)', {})).toBe(
      '**plain** [a](https://x.example)',
    );
  });
});
