/**
 * Originally ported from wpd-core's core/dateConversion.js.
 * Original: WebPlotDigitizer, Copyright (C) 2025 Ankit Rohatgi, AGPL-3.0.
 * See core/mathFunctions.ts for porting-provenance notes.
 *
 * Ported in full even though it's not in core/'s primary calibration-math
 * path - inputParser.ts has a hard dependency on it (date-formatted axis
 * values), confirmed while reading the original source. See CLAUDE.md's
 * "Current scoped task" note anticipating exactly this.
 */

function toJD(dateStringInput: string): number | null {
  const dateString = dateStringInput.toString();
  const dateParts = dateString.split(/[/ :]/);
  const hasDatePart = dateString.indexOf('/') >= 0;
  let year: number, month: number, date: number, timeIdxOffset: number;

  if (dateParts.length <= 0 || dateParts.length > 6) {
    return null;
  }

  if (hasDatePart) {
    year = parseInt(dateParts[0]!, 10);
    month = parseInt(dateParts[1] === undefined ? '0' : dateParts[1], 10);
    date = parseInt(dateParts[2] === undefined ? '1' : dateParts[2], 10);
    timeIdxOffset = 3;
  } else {
    const today = new Date();
    year = today.getFullYear();
    month = today.getMonth() + 1;
    date = today.getDate();
    timeIdxOffset = 0;
  }
  const hourPart = dateParts[timeIdxOffset];
  const minPart = dateParts[timeIdxOffset + 1];
  const hour = parseInt(hourPart === undefined ? '0' : hourPart, 10);
  const min = parseInt(minPart === undefined ? '0' : minPart, 10);

  let sec: number, msec: number;
  const hasSec = dateParts[timeIdxOffset + 2] !== undefined;
  if (hasSec) {
    const secPart = dateParts[timeIdxOffset + 2]!;
    const fval = parseFloat(secPart);
    sec = parseInt(String(fval), 10);
    if (fval - sec >= 0.001 && secPart.indexOf('.') >= 0) {
      msec = parseInt(String(parseFloat('.' + secPart.split('.')[1]) * 1000), 10);
    } else {
      msec = 0;
    }
  } else {
    sec = 0;
    msec = 0;
  }

  if (isNaN(year) || isNaN(month) || isNaN(date) || isNaN(hour) || isNaN(min) || isNaN(sec)) {
    return null;
  }
  if (month > 12 || month < 1) return null;
  if (date > 31 || date < 1) return null;
  if (hour > 23 || hour < 0) return null;
  if (min > 59 || min < 0) return null;
  if (sec > 59 || sec < 0) return null;
  if (msec > 1000 || msec < 0) return null;

  const tempDate = new Date();
  // Seed the day-of-month to 1 before setting the month. Otherwise, when today's
  // date-of-month exceeds the target month's length (e.g. run on the 31st,
  // parsing a February date), setUTCMonth overflows into the next month *before*
  // setUTCDate corrects it - yielding the wrong day, non-deterministically by run
  // date. Divergence from the upstream port is deliberate: reliable data out
  // (Tenet 1) trumps faithfulness here. setUTCFullYear is kept (not Date.UTC) to
  // preserve literal 2-digit years, which Date.UTC would map to 1900-1999.
  tempDate.setUTCDate(1);
  tempDate.setUTCFullYear(year);
  tempDate.setUTCMonth(month - 1);
  tempDate.setUTCDate(date);
  tempDate.setUTCHours(hour, min, sec, msec);
  // Reject an IMPOSSIBLE calendar date (e.g. 2021/02/31). The field-range checks
  // above pass it (month 1-12, day 1-31), but setUTCDate then ROLLS it into the
  // next month -- silently shifting the whole axis scale (2021/02/31 -> Mar 3).
  // If the constructed date no longer matches the entered month/day, it was
  // never a real date: return null so the value reads as invalid (the
  // calibration guard surfaces it) instead of becoming a wrong number. Sibling
  // of the setUTCDate(1) seeding above -- both serve Tenet 1 over upstream
  // faithfulness.
  if (tempDate.getUTCMonth() !== month - 1 || tempDate.getUTCDate() !== date) {
    return null;
  }
  const rtnValue = parseFloat(String(tempDate.getTime()));
  if (!isNaN(rtnValue)) {
    return rtnValue;
  }
  return null;
}

export function parse(input: unknown): number | null {
  if (input == null) {
    return null;
  }
  // ⚑ THE "LOOKS LIKE A DATE" GUARD APPLIES WHATEVER THE TYPE (2026-07-28).
  //
  // Upstream ran this check only for a `string`, so a NUMBER skipped it and went
  // straight to toJD -- which stringifies its argument, finds no date part, and
  // reads the value as an HOUR OF TODAY. `parse(0)` therefore returned a
  // timestamp for midnight today while `parse('0')` correctly returned null, and
  // only 0..23 were affected because toJD rejects hour > 23. Ordinary axis
  // values 0, 1 and 10 silently became ~1.78e12.
  //
  // It was reachable from real data, not just in theory: WPD's BarAxes stores
  // calibration values as INTEGERS and core/plotData.ts hands them straight to
  // Calibration, where core/axes/bar.ts's `|| ip.isDate` guard then REFUSED to
  // calibrate a perfectly good figure. The `.dig` and StarryDigitizer importers
  // hit the same edge until they were made to pass text.
  //
  // Fixing it HERE rather than at each caller is deliberate -- guards belong in
  // the model, and the model has more than one entrance. A date always carries a
  // `/` or a `:`; a number never can, so nothing legitimate is lost.
  const text = String(input);
  if (text.indexOf('/') < 0 && text.indexOf(':') < 0) {
    return null;
  }
  return toJD(text);
}

function formatDate(dateObject: Date, formatString: string): string {
  const longMonths: string[] = [];
  const shortMonths: string[] = [];
  const tmpDate = new Date('1/1/2021');

  for (let i = 0; i < 12; i++) {
    tmpDate.setUTCMonth(i);
    longMonths.push(tmpDate.toLocaleString(undefined, { month: 'long' }));
    shortMonths.push(tmpDate.toLocaleString(undefined, { month: 'short' }));
  }

  let outputString = formatString;
  outputString = outputString.replace('YYYY', 'yyyy');
  outputString = outputString.replace('YY', 'yy');
  outputString = outputString.replace('MMMM', 'mmmm');
  outputString = outputString.replace('MMM', 'mmm');
  outputString = outputString.replace('MM', 'mm');
  outputString = outputString.replace('DD', 'dd');
  outputString = outputString.replace('HH', 'hh');
  outputString = outputString.replace('II', 'ii');
  outputString = outputString.replace('SS', 'ss');
  outputString = outputString.replace('.FRAC', '.frac');

  outputString = outputString.replace('yyyy', String(dateObject.getUTCFullYear()));

  const twoDigitYearNum = dateObject.getUTCFullYear() % 100;
  const twoDigitYear = twoDigitYearNum < 10 ? '0' + twoDigitYearNum : String(twoDigitYearNum);
  outputString = outputString.replace('yy', twoDigitYear);

  outputString = outputString.replace('mmmm', longMonths[dateObject.getUTCMonth()]!);
  outputString = outputString.replace('mmm', shortMonths[dateObject.getUTCMonth()]!);
  outputString = outputString.replace('mm', ('0' + (dateObject.getUTCMonth() + 1)).slice(-2));
  outputString = outputString.replace('dd', ('0' + dateObject.getUTCDate()).slice(-2));

  outputString = outputString.replace('hh', ('0' + dateObject.getUTCHours()).slice(-2));
  outputString = outputString.replace('ii', ('0' + dateObject.getUTCMinutes()).slice(-2));
  const secStr = ('0' + dateObject.getUTCSeconds()).slice(-2);
  const milliStr = ('00' + dateObject.getUTCMilliseconds()).slice(-3);
  outputString = outputString.replace('ss.frac', secStr + '.' + milliStr);
  outputString = outputString.replace('ss', secStr);

  return outputString;
}

export function formatDateNumber(dateNumber: number, formatString: string): string {
  let coeff = 1;
  if (formatString.indexOf('frac') >= 0) coeff = 1.0;
  else if (formatString.indexOf('s') >= 0) coeff = 1000;
  else if (formatString.indexOf('i') >= 0) coeff = 1000 * 60;
  else if (formatString.indexOf('h') >= 0) coeff = 1000 * 60 * 60;
  else if (formatString.indexOf('d') >= 0) coeff = 1000 * 60 * 60 * 24;
  else if (formatString.indexOf('m') >= 0) coeff = 1.0;
  else if (formatString.indexOf('y') >= 0) coeff = 1.0;

  return formatDate(
    new Date(Math.round(new Date(dateNumber).getTime() / coeff) * coeff),
    formatString
  );
}

export function getFormatString(dateString: string): string {
  const dateParts = dateString.split(/[/ :]/);
  const hasDatePart = dateString.indexOf('/') >= 0;
  let formatString = 'yyyy/mm/dd hh:ii:ss';

  if (dateParts.length >= 1) {
    formatString = hasDatePart ? 'yyyy' : 'hh';
  }
  if (dateParts.length >= 2) {
    formatString += hasDatePart ? '/mm' : ':ii';
  }
  if (dateParts.length >= 3) {
    formatString += hasDatePart ? '/dd' : ':ss';
  }
  if (dateParts.length >= 4) {
    formatString += ' hh';
  }
  if (dateParts.length >= 5) {
    formatString += ':ii';
  }
  if (dateParts.length === 6) {
    formatString += ':ss';
  }
  return formatString;
}
