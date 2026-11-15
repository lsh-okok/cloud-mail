import { describe, expect, it } from 'vitest';
import { domainToASCII } from 'node:url';
import serverVerify from '../src/utils/verify-utils.js';
import { isEmail, isDomain } from '../../mail-vue/src/utils/verify-utils.js';

for (const [name, verify] of Object.entries({ frontend: { isEmail, isDomain }, backend: serverVerify })) {
  describe(`${name} receiving domain validators`, () => {
    it.each(['example.com', 'MAIL.Example.TEST', 'sub.xn--bcher-kva.de',
      domainToASCII('例子.中国'), domainToASCII('пример.рф'), domainToASCII('도메인.한국')])(
      'accepts ASCII and normalized international domain %s', domain => {
        expect(verify.isDomain(domain)).toBe(true);
        expect(verify.isEmail(`reader+tag@${domain}`)).toBe(true);
        expect(verify.isEmail(`reader@${domain.toUpperCase()}`)).toBe(true);
      });

    it.each(['localhost', 'example.c', 'example.123', 'example.xn--', 'example.xn---',
      'example.xn--abc-', `example.xn--${'a'.repeat(60)}`, 'example..com', 'example.com.',
      'https://example.com', '*.example.com', 'example.com:25', 'example.com/path',
      'example.com?x=1', 'example.com#mail', 'example .com', '例子.中国'])(
      'rejects malformed or unnormalized domain %s', domain => {
        expect(verify.isDomain(domain)).toBe(false);
        expect(verify.isEmail(`reader@${domain}`)).toBe(false);
      });

    it.each(['reader', '@example.com', 'reader@@example.com', 'reader name@example.com',
      'reader@https://example.com'])('rejects malformed email %s', email => {
        expect(verify.isEmail(email)).toBe(false);
      });
  });
}
