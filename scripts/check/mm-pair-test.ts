// The matchmaking lobby's pairing rule, on its own (npx tsx scripts/check/mm-pair-test.ts):
// same continent first, anyone after 20 s, the earliest-arrived hosts.
import { pickPair, FAR_AFTER_MS, type Waiter } from '../../cloud/lobby';

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
};

interface W extends Waiter {
  id: string;
}
const w = (id: string, since: number, continent?: string): W => ({ id, since, continent });
const ids = (p: { host: W; guest: W } | null) => (p ? `${p.host.id}>${p.guest.id}` : 'none');

check('an empty queue and a lone TV pair with nobody', pickPair<W>([], 0) === null && pickPair([w('a', 0, 'NA')], 99_999) === null);

check('two TVs on one continent pair at once; the earlier arrival hosts', ids(pickPair([w('b', 1000, 'EU'), w('a', 500, 'EU')], 1000)) === 'a>b', ids(pickPair([w('b', 1000, 'EU'), w('a', 500, 'EU')], 1000)));

check('a TV with no continent (a local server) pairs with another such TV', ids(pickPair([w('a', 0), w('b', 10)], 10)) === 'a>b');

check('two continents do not pair before 20 s', pickPair([w('a', 0, 'NA'), w('b', 5000, 'EU')], 19_000) === null);
check('…and do, once the longest-waiting has waited 20 s: it hosts', ids(pickPair([w('a', 0, 'NA'), w('b', 5000, 'EU')], FAR_AFTER_MS)) === 'a>b');
check('…the 20 s counts from the longest-waiting TV, not the newcomer', ids(pickPair([w('b', 19_000, 'EU'), w('a', 0, 'NA')], 20_500)) === 'a>b');

check(
  'the longest-waiting TV takes the earliest-arrived one of ITS continent, not the earliest of all',
  ids(pickPair([w('a', 0, 'NA'), w('b', 100, 'EU'), w('c', 200, 'NA'), w('d', 300, 'NA')], 1000)) === 'a>c',
  ids(pickPair([w('a', 0, 'NA'), w('b', 100, 'EU'), w('c', 200, 'NA'), w('d', 300, 'NA')], 1000)),
);

check(
  'a lonely first arrival does not block the others: two Europeans behind a North American still play',
  ids(pickPair([w('a', 0, 'NA'), w('b', 100, 'EU'), w('c', 200, 'EU')], 1000)) === 'b>c',
);

check(
  'after 20 s the longest-waiting TV takes the earliest-arrived other TV of any continent',
  ids(pickPair([w('a', 0, 'NA'), w('b', 100, 'EU'), w('c', 200, 'EU')], 25_000)) === 'a>b',
  ids(pickPair([w('a', 0, 'NA'), w('b', 100, 'EU'), w('c', 200, 'EU')], 25_000)),
);

check('same continent still wins over an earlier arrival from elsewhere, even after 20 s', ids(pickPair([w('a', 0, 'NA'), w('b', 100, 'EU'), w('c', 200, 'NA')], 25_000)) === 'a>c');

check('arrival order breaks a tie in time (the queue order)', ids(pickPair([w('x', 5, 'AS'), w('y', 5, 'AS')], 5)) === 'x>y');

const q = [w('a', 0, 'NA'), w('b', 1, 'NA')];
const copy = JSON.stringify(q);
pickPair(q, 100_000);
check('the queue is not changed', JSON.stringify(q) === copy);

// draining a queue the way the lobby does: pair, remove both, repeat
{
  const queue = [w('a', 0, 'NA'), w('b', 1, 'EU'), w('c', 2, 'NA'), w('d', 3, 'EU'), w('e', 4, 'AS')];
  const out: string[] = [];
  for (let p = pickPair(queue, 5); p; p = pickPair(queue, 5)) {
    out.push(ids(p));
    queue.splice(queue.indexOf(p.host), 1);
    queue.splice(queue.indexOf(p.guest), 1);
  }
  check('draining pairs each continent together and leaves the odd one out', out.join() === 'a>c,b>d' && queue.length === 1 && queue[0].id === 'e', `${out.join()} left ${queue.map((x) => x.id)}`);
}

console.log(fail ? `\n${fail} checks FAILED` : '\nAll pairing checks passed.');
process.exit(fail ? 1 : 0);
