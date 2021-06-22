import { HistoryIntervalOptions, HistoryOptions } from '../history';
import { cli, date, file } from '@debut/plugin-utils';
import { Candle, TimeFrame } from '@debut/types';
import { createProgress } from './utils';
import { AlpacaClient, Bar } from '@master-chief/alpaca';

type AlpacaTransportArgs = {
    atoken: string;
    asecret: string;
};

const tokens = cli.getTokens();
const { atoken = 'alpacaKey', asecret = 'alpacaSecret' } = cli.getArgs<AlpacaTransportArgs>();
const key = tokens[atoken];
const secret = tokens[asecret];

const now = new Date();
const alpaca = new AlpacaClient({ credentials: { key, secret } });

export async function getHistoryIntervalAlpaca({
    ticker,
    start,
    end,
    interval,
}: HistoryIntervalOptions): Promise<Candle[]> {
    const filterFrom = start;
    const filterTo = end;

    start = ~~(start / 86400000) * 86400000 - now.getTimezoneOffset() * 60 * 1000;
    end = ~~(end / 86400000) * 86400000;

    const reqs = [];
    let tries = 0;
    let from = start;
    let to = from;
    let chunkStart: number;
    let result: Candle[] = [];

    while (to <= end) {
        try {
            to = from + 86400 * 1000;

            if (!chunkStart) {
                chunkStart = from;
            }

            let promise: Promise<Candle[]> = requestDay(from, to, ticker, interval);

            reqs.push(promise);

            if (reqs.length === 50 || to >= end) {
                const data = await collectCandles(reqs);
                result = result.concat(data);

                reqs.length = 0;
                tries = 0;
                chunkStart = to;
            }

            from = to;
        } catch (e) {
            tries++;
            reqs.length = 0;
            from = chunkStart;
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, tries) * 10_000));
        }
    }

    return result.filter((candle) => candle.time >= filterFrom && candle.time <= filterTo);
}

export async function getHistoryFromAlpaca({ ticker, days, interval, gapDays }: HistoryOptions) {
    const reqs = [];

    now.setMinutes(0);
    now.setHours(0);
    now.setSeconds(0);
    now.setMilliseconds(0);

    let end = now.getTime() - now.getTimezoneOffset() * 60 * 1000 - 86400000 * gapDays;
    let from: number = end - 86400000 * days;
    let to = from;
    let chunkStart: number;
    let tries = 0;
    let result: Candle[] = [];
    let progressValue = 0;

    // alpaca premiun only has access to last 15min
    // ltes remove 15 min from end, if gapDays is 0
    // and try to get last 15 min in different request as is posiible optional
    if (!gapDays) {
        end -= 900000;
    }

    console.log(`History loading from ${new Date(from).toLocaleDateString()}:\n`);
    const progress = createProgress();
    progress.start(days, 0);

    while (to <= end) {
        try {
            to = from + 86400 * 1000;

            if (!chunkStart) {
                chunkStart = from;
            }

            const promise: Promise<Candle[]> = requestDay(from, to, ticker, interval);

            reqs.push(promise);

            if (reqs.length === 50 || to >= end) {
                const data = await collectCandles(reqs);
                result = result.concat(data);

                reqs.length = 0;
                tries = 0;
                chunkStart = to;
            }

            progressValue++;
            progress.update(progressValue);
            from = to;
        } catch (e) {
            tries++;
            progressValue -= reqs.length - 1;
            progress.update(progressValue);
            reqs.length = 0;
            from = chunkStart;

            if (e.code || !e.code) {
                console.log(e.message);
                throw e;
            }

            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, tries) * 10_000));
        }
    }

    progress.update(days);
    progress.stop();

    return result;
}

function saveDay(path: string, data: Candle[]) {
    file.ensureFile(path);
    file.saveFile(path, data);
}

function getPath(ticker: string, interval: TimeFrame, from: number, to: number) {
    return `history/alpaca/${ticker}/${interval}/${from / 100000}-${to / 100000}.txt`;
}

async function collectCandles(reqs: Array<Promise<Candle[]>>) {
    const res: Array<Candle[]> = await Promise.all(reqs);
    let result: Candle[] = [];

    res.forEach((candles) => {
        if (!candles) {
            console.log('missed data');
            return;
        }

        result = result.concat(candles.filter(Boolean));
    });

    return result;
}

async function requestDay(from: number, to: number, ticker: string, interval: TimeFrame): Promise<Candle[]> {
    // Не запрашиваем историю текущего дня
    if (date.isWeekend(from)) {
        return Promise.resolve([]);
    }

    const path = getPath(ticker, interval, from, to);
    const historyFile = file.readFile(path);

    if (historyFile) {
        return Promise.resolve(JSON.parse(historyFile));
    }

    const candles = await alpaca.getBars({
        symbol: ticker,
        start: new Date(from),
        end: new Date(to),
        timeframe: convertTimeFrame(interval),
    });

    const result = candles.bars.map(transformAlpacaCandle);

    if (!date.isSameDay(new Date(), new Date(from))) {
        saveDay(path, result);
    }

    return result;
}

function convertTimeFrame(timeframe: TimeFrame) {
    switch (timeframe) {
        case '1min':
            return '1Min';
        case '1h':
            return '1Hour';
        case 'day':
            return '1Day';
    }

    throw `Alpaca integration does not support ${timeframe} timeframe`;
}

function transformAlpacaCandle(bar: Bar): Candle {
    const rawBar = bar.raw();
    const time = Date.parse(rawBar.t);

    return {
        o: rawBar.o,
        h: rawBar.h,
        l: rawBar.l,
        c: rawBar.c,
        v: rawBar.v,
        time,
    };
}