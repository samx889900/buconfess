import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { censorAbuseTerms } from '../apps/admin/lib/censor';

describe('Deterministic Abuse Term Censoring (v3.5)', () => {
  it('1. Censors standalone "bc" (lowercase and uppercase)', () => {
    assert.equal(censorAbuseTerms('Ye kya hai bc!'), 'Ye kya hai b*!');
    assert.equal(censorAbuseTerms('Ye kya hai BC!'), 'Ye kya hai B*!');
    assert.equal(censorAbuseTerms('Bc yeh sach hai?'), 'B* yeh sach hai?');
    assert.equal(censorAbuseTerms('bc'), 'b*');
    assert.equal(censorAbuseTerms('BC'), 'B*');
  });

  it('2. Censors "bhenchod" (lowercase, uppercase, mixed case)', () => {
    assert.equal(censorAbuseTerms('Are bhenchod yeh kya ho gaya'), 'Are b*****d yeh kya ho gaya');
    assert.equal(censorAbuseTerms('Are BHENCHOD yeh kya ho gaya'), 'Are B*****D yeh kya ho gaya');
    assert.equal(censorAbuseTerms('bhenchod'), 'b*****d');
    assert.equal(censorAbuseTerms('BHENCHOD'), 'B*****D');
  });

  it('3. Handles punctuation and spacing variants of "bc"', () => {
    assert.equal(censorAbuseTerms('kya b.c yaar'), 'kya b* yaar');
    assert.equal(censorAbuseTerms('kya b c yaar'), 'kya b* yaar');
    assert.equal(censorAbuseTerms('kya b-c yaar'), 'kya b* yaar');
    assert.equal(censorAbuseTerms('kya b_c yaar'), 'kya b* yaar');
  });

  it('4. Handles spacing and punctuation variants of "bhenchod"', () => {
    assert.equal(censorAbuseTerms('kya b h e n c h o d hai'), 'kya b*****d hai');
    assert.equal(censorAbuseTerms('kya b-h-e-n-c-h-o-d hai'), 'kya b*****d hai');
  });

  it('5. Strictly preserves innocent words containing substrings', () => {
    // Words containing 'bc':
    assert.equal(censorAbuseTerms('because of you'), 'because of you');
    assert.equal(censorAbuseTerms('abc is the alphabet'), 'abc is the alphabet');
    assert.equal(censorAbuseTerms('broadcast the message'), 'broadcast the message');
    assert.equal(censorAbuseTerms('subconscious mind'), 'subconscious mind');

    // Words containing 'mc':
    assert.equal(censorAbuseTerms('match tomorrow'), 'match tomorrow');
    assert.equal(censorAbuseTerms('welcome to campus'), 'welcome to campus');

    // Words containing 'shit':
    assert.equal(censorAbuseTerms('night shift at library'), 'night shift at library');
    assert.equal(censorAbuseTerms('shuttle bus schedule'), 'shuttle bus schedule');

    // Words containing 'ass':
    assert.equal(censorAbuseTerms('submit the assignment today'), 'submit the assignment today');
    assert.equal(censorAbuseTerms('enter your password'), 'enter your password');
    assert.equal(censorAbuseTerms('attend math class in room 101'), 'attend math class in room 101');
    assert.equal(censorAbuseTerms('water glass on the table'), 'water glass on the table');
    assert.equal(censorAbuseTerms('compass for geometry'), 'compass for geometry');

    // Words containing 'bitch' / 'chutiya' / etc.:
    assert.equal(censorAbuseTerms('beach vacation in Goa'), 'beach vacation in Goa');
    assert.equal(censorAbuseTerms('chutney with samosa'), 'chutney with samosa');
    assert.equal(censorAbuseTerms('document your code'), 'document your code');
    assert.equal(censorAbuseTerms('republic day celebration'), 'republic day celebration');
  });

  it('6. Censors other common Hinglish abuse terms', () => {
    assert.equal(censorAbuseTerms('kya madarchod harkat hai'), 'kya m*******d harkat hai');
    assert.equal(censorAbuseTerms('ye chutiya kon hai'), 'ye c*****a kon hai');
    assert.equal(censorAbuseTerms('gaand fati'), 'g***d fati');
    assert.equal(censorAbuseTerms('lodu aadmi'), 'l**u aadmi');
    assert.equal(censorAbuseTerms('kya bsdk bol raha'), 'kya b**k bol raha');
    assert.equal(censorAbuseTerms('harami dost'), 'h****i dost');
  });

  it('7. Censors English abuse terms with boundary protection', () => {
    assert.equal(censorAbuseTerms('what the fuck is this'), 'what the f**k is this');
    assert.equal(censorAbuseTerms('FUCK THAT'), 'F**K THAT');
    assert.equal(censorAbuseTerms('this is total shit'), 'this is total s**t');
    assert.equal(censorAbuseTerms('stop being an asshole'), 'stop being an a*****e');
    assert.equal(censorAbuseTerms('crazy bitch'), 'crazy b***h');
  });

  it('8. Handles multiple abuse terms in a single confession string', () => {
    const raw = 'Bhai bc, vo bhenchod professor ne kya assignment diya fuck this shit!';
    const censored = censorAbuseTerms(raw);
    assert.ok(!censored.includes('bc,'));
    assert.ok(!censored.includes('bhenchod'));
    assert.ok(!censored.includes('fuck'));
    assert.ok(!censored.includes('shit'));
    // Innocents remain:
    assert.ok(censored.includes('assignment'));
    assert.ok(censored.includes('professor'));
  });
});
