/**
 * Originally ported from wpd-core's core/inputParser.js.
 * Original: WebPlotDigitizer, Copyright (C) 2025 Ankit Rohatgi, AGPL-3.0.
 * See core/mathFunctions.ts for porting-provenance notes.
 *
 * ⚑⚑ A NUMBER IS THE WHOLE STRING OR IT IS NOTHING. See `parseWholeNumber`
 * below. Prefix parsing - taking `12` from `12abc` and discarding the rest -
 * accepts a typo as a measurement and tells the user nothing, which under tenet
 * 1 ("graph in, RELIABLE data out") is the worst failure this tool can ship.
 */

import * as dateConverter from './dateConversion.js';

/**
 * `input` as a number, but **only if the WHOLE string is one** - else null.
 *
 * **The divergence, and why it earns itself** (found by execution 2026-07-17,
 * during what was logged as a Bar-only defect and turned out to be this):
 * upstream's `parseFloat` is a *prefix* parser, and `InputParser` only rejected
 * `NaN`. So every one of these was accepted as valid, on **all 7 axes types
 * including XY**, with nothing on screen wrong:
 *
 * | typed        | became  | isValid |
 * |--------------|---------|---------|
 * | `"1,000"`    | `1`     | true    |  ← a thousands separator. Every value 1000x wrong.
 * | `"5 kg"`     | `5`     | true    |
 * | `"1.2.3"`    | `1.2`   | true    |
 * | `"5%"`       | `5`     | true    |
 * | `"2024-01-01"`| `2024` | true    |  ← the ISO-date bug (parity gap 8b)
 * | `"2+3"`      | `2`     | true    |
 *
 * `Number()` is exactly the "whole string" parser `parseFloat` is not, so the
 * fix is to use it. Everything legitimate still passes: `"10"`, `"1e3"`,
 * `"-5"`, `" 42 "`, and any real date (`"2024/01/01"`, `"12:30"`), which the
 * date path claims *before* this runs.
 *
 * **This also closes parity gap 8b, whose stated defence was doubly wrong.**
 * It argued the ISO date was (a) *"INHERITED, NOT OURS - byte-for-byte
 * upstream's, so we are at parity and the tenet holds"* - parity with WPD is
 * not a defence for anything (tenet 5) - and (b) *"NOT a cheap fix: WPD accepts
 * equations in calibration values, so `2024-01-01` is genuinely ambiguous
 * between a date and a subtraction."* **Verified by execution: equations do NOT
 * work.** `"2+3"` yields `2`, not 5; there is no equation evaluation anywhere in
 * this file, ours or upstream. There was never anything for the `-` to be
 * ambiguous *with*. (CLAUDE.md's "value transforms are NOT unreachable -
 * equations already work" rule-out is false for the same reason.)
 *
 * **Empty string is refused explicitly**, because `Number("")` is `0` where
 * `parseFloat("")` was `NaN` - the one place a naive swap would have made
 * things worse, turning a blank field into a silent zero.
 *
 * **Known, deliberate non-change:** `"10/2"` still reads as a *date*
 * (−61848921600000), because the date path claims anything containing `/`
 * before this runs. That is WPD's documented rule, and with equations proven
 * non-functional nobody could have meant division by it. Left alone rather than
 * silently widening this fix into a date-vs-fraction decision.
 */
function parseWholeNumber(input: unknown): number | null {
  const text = typeof input === 'string' ? input.trim() : input;
  if (text === '' || text == null) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return value;
}

export class InputParser {
  isValid = false;
  isDate = false;
  formatting: string | null = null;
  isArray = false;

  parse(input: unknown): number | number[] | string[] | null {
    this.isValid = false;
    this.isDate = false;
    this.formatting = null;
    // ⚑ isArray was the one flag NOT reset here (2026-07-31 mutation sweep).
    // A single InputParser is deliberately reused across many values -- one
    // `ip` walks every spoke in SpiderAxes.calibrate, and every one of the
    // four fields in CircularChartRecorderAxes.calibrate -- so once any value
    // parsed as an array, `isArray` stayed true for every value after it. No
    // live defect (nothing in the product reads it yet), which is exactly why
    // it survived: it is only observable from a test. Reset with its three
    // siblings so the whole reported state describes THIS call and not a
    // previous one.
    this.isArray = false;

    if (input == null) {
      return null;
    }

    let normalizedInput: unknown = input;
    if (typeof input === 'string') {
      const trimmed: string = input.trim();
      if (trimmed.indexOf('^') >= 0) {
        return null;
      }
      normalizedInput = trimmed;
    }

    const parsedDate = dateConverter.parse(normalizedInput);
    if (parsedDate != null) {
      this.isValid = true;
      this.isDate = true;
      this.formatting = dateConverter.getFormatString(String(normalizedInput));
      return parsedDate;
    }

    if (typeof normalizedInput === 'string') {
      const parsedArray = this._parseArray(normalizedInput);
      if (parsedArray != null) {
        this.isValid = true;
        this.isArray = true;
        if (this._hasDates(normalizedInput)) {
          this.isDate = true;
          this.formatting = dateConverter.getFormatString(String(parsedArray[0]));
        }
        return parsedArray;
      }
    }

    const parsedNumber = parseWholeNumber(normalizedInput);
    if (parsedNumber !== null) {
      this.isValid = true;
      return parsedNumber;
    }

    return null;
  }

  private _hasDates(input: string): boolean {
    if (input.indexOf('/') > 0 || input.indexOf(':') > 0) {
      return true;
    }
    return false;
  }

  private _parseArray(input: string): number[] | string[] | null {
    if (input.indexOf('[') < 0 || input.indexOf(']') < 0) {
      return null;
    }

    if (this._hasDates(input)) {
      const valArray = input.replace('[', '').replace(']', '').split(',').map((v) => v.trim());
      if (valArray.length === 0) {
        return null;
      }
      return valArray;
    } else {
      // Same whole-string rule as the scalar path (checkpoint 81): upstream's
      // parseFloat+filter(!isNaN) silently turned "[1 kg, 2]" into [1, 2] and
      // "[1,2]" into... also [1, 2], which is correct only by accident. An
      // element that is not entirely a number is dropped rather than
      // prefix-parsed, so a malformed list shortens (and a wholly malformed one
      // returns null) instead of quietly reporting wrong values.
      const valArray = input
        .replace('[', '')
        .replace(']', '')
        .split(',')
        .map((v) => parseWholeNumber(v))
        .filter((v): v is number => v !== null);
      if (valArray.length === 0) {
        return null;
      }
      return valArray;
    }
  }
}
