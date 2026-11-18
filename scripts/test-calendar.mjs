import assert from 'node:assert/strict';
import {
  buildMonthGrid,
  formatDate,
  getWeekdayLabels,
  toDigits,
} from '../src/lib/calendar.ts';
import {
  isLeapJalaaliYear,
  jalaaliMonthLength,
  toGregorian,
  toJalaali,
} from 'jalaali-js';

let convertedDateCount = 0;

for (let year = 1380; year <= 1450; year += 1) {
  for (let month = 1; month <= 12; month += 1) {
    const days = jalaaliMonthLength(year, month);
    for (let day = 1; day <= days; day += 1) {
      const gregorian = toGregorian(year, month, day);
      const back = toJalaali(gregorian.gy, gregorian.gm, gregorian.gd);
      assert.deepEqual(
        back,
        { jy: year, jm: month, jd: day },
        `Jalali round trip failed for ${year}/${month}/${day}`,
      );
      convertedDateCount += 1;
    }
  }
}

for (let year = 1380; year <= 1450; year += 1) {
  const esfandDays = jalaaliMonthLength(year, 12);
  assert.equal(esfandDays, isLeapJalaaliYear(year) ? 30 : 29);
  for (const day of [29, esfandDays]) {
    const gregorian = toGregorian(year, 12, day);
    assert.deepEqual(toJalaali(gregorian.gy, gregorian.gm, gregorian.gd), {
      jy: year,
      jm: 12,
      jd: day,
    });
  }
}

const jalaliGrid = buildMonthGrid('jalali', 1403, 12, 'sat');
const gregorianGrid = buildMonthGrid('gregorian', 2025, 2, 'mon');
assert.equal(jalaliGrid.length, 42);
assert.equal(jalaliGrid.filter((cell) => cell.isCurrentMonth).length, 30);
assert.equal(gregorianGrid.filter((cell) => cell.isCurrentMonth).length, 28);
assert.equal(getWeekdayLabels('en', 'sat')[0], 'Saturday');
assert.equal(toDigits(1403, 'persian'), '۱۴۰۳');
assert.equal(toDigits(1403, 'latin'), '1403');
assert.match(formatDate('2025-03-21T12:00:00.000Z', 'jalali', 'fa', 'persian'), /فروردین/);
assert.match(formatDate('2025-03-21T12:00:00.000Z', 'both', 'en', 'latin'), / \/ /);

console.log(`Calendar checks passed for ${convertedDateCount} Jalali dates.`);
