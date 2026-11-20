<?php
// Čas v pásmu Europe/Prague (src/node/lib/time.js). Datum lovu = kalendářní den (YYYY-MM-DD),
// okamžiky se ukládají jako ISO čas v UTC s milisekundami (stejný formát jako Node).
namespace Mistenka;

defined('ABSPATH') || exit;

final class Time
{
    public const TZ = 'Europe/Prague';
    private const CLOCK_OPTION = 'mistenka_dev_clock';
    private static ?\DateTimeZone $utc = null;
    private static ?\DateTimeZone $prague = null;
    private static $clock = false; // false = nenačteno, null = skutečný čas

    public static function utc(): \DateTimeZone
    {
        return self::$utc ??= new \DateTimeZone('UTC');
    }

    public static function prague(): \DateTimeZone
    {
        return self::$prague ??= new \DateTimeZone(self::TZ);
    }

    // Posun času je jen pro testy (MISTENKA_DEV) a drží se v options (PHP nemá stav mezi požadavky).
    public static function now(): \DateTimeImmutable
    {
        if (self::$clock === false) {
            $stored = Env::dev() ? get_option(self::CLOCK_OPTION, '') : '';
            self::$clock = $stored ? self::parse($stored) : null;
        }
        if (self::$clock) return self::$clock;
        return new \DateTimeImmutable('now', self::utc());
    }

    public static function setClock(?string $value): void
    {
        if ($value) {
            $parsed = self::parse($value);
            if (!$parsed) throw new \InvalidArgumentException('Neplatný čas.');
            update_option(self::CLOCK_OPTION, self::iso($parsed), true);
            self::$clock = $parsed;
        } else {
            delete_option(self::CLOCK_OPTION);
            self::$clock = null;
        }
    }

    public static function parse(?string $value): ?\DateTimeImmutable
    {
        if ($value === null || $value === '') return null;
        try {
            $date = new \DateTimeImmutable($value);
        } catch (\Exception $e) {
            return null;
        }
        return $date->setTimezone(self::utc());
    }

    public static function iso(\DateTimeImmutable $date): string
    {
        return $date->setTimezone(self::utc())->format('Y-m-d\TH:i:s.v\Z');
    }

    public static function nowIso(): string
    {
        return self::iso(self::now());
    }

    public static function ms(\DateTimeImmutable $date): int
    {
        return (int) $date->format('Uv');
    }

    public static function fromMs(int $ms): \DateTimeImmutable
    {
        $seconds = intdiv($ms, 1000);
        $rest = $ms - $seconds * 1000;
        if ($rest < 0) { $seconds -= 1; $rest += 1000; }
        $date = \DateTimeImmutable::createFromFormat('U.u', sprintf('%d.%06d', $seconds, $rest * 1000), self::utc());
        return $date->setTimezone(self::utc());
    }

    public static function msOf(?string $iso): ?int
    {
        $date = self::parse($iso);
        return $date ? self::ms($date) : null;
    }

    public static function addMinutes(\DateTimeImmutable $date, int $minutes): \DateTimeImmutable
    {
        return self::fromMs(self::ms($date) + $minutes * 60000);
    }

    public static function isIsoDate($value): bool
    {
        $text = is_string($value) ? $value : '';
        if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $text, $m)) return false;
        return checkdate((int) $m[2], (int) $m[3], (int) $m[1]);
    }

    public static function pragueToday(?\DateTimeImmutable $at = null): string
    {
        return ($at ?? self::now())->setTimezone(self::prague())->format('Y-m-d');
    }

    public static function addDays(string $isoDate, int $days): string
    {
        $date = new \DateTimeImmutable($isoDate . ' 12:00:00', self::utc());
        return $date->modify(($days >= 0 ? '+' : '') . $days . ' days')->format('Y-m-d');
    }

    // Místní čas v Praze (např. "2026-11-08" + "24:00") → okamžik v UTC. Zvládá letní/zimní čas.
    public static function pragueLocalToDate(string $isoDate, string $time = '00:00'): \DateTimeImmutable
    {
        if ($time === '24:00') {
            $isoDate = self::addDays($isoDate, 1);
            $time = '00:00';
        }
        return (new \DateTimeImmutable($isoDate . ' ' . $time . ':00', self::prague()))->setTimezone(self::utc());
    }

    // Pondělí kalendářního týdne (po–ne).
    public static function weekStart(string $isoDate): string
    {
        $dow = (int) (new \DateTimeImmutable($isoDate . ' 12:00:00', self::utc()))->format('N') - 1;
        return self::addDays($isoDate, -$dow);
    }

    public static function monthEnd(string $isoDate): string
    {
        return (new \DateTimeImmutable($isoDate . ' 12:00:00', self::utc()))->format('Y-m-t');
    }

    public static function monthOf(string $isoDate): int
    {
        return (int) substr($isoDate, 5, 2);
    }

    // Před `years` lety (pro lhůty uchování), jako setUTCFullYear v Node.
    public static function yearsAgo(int $years): \DateTimeImmutable
    {
        return self::now()->modify('-' . $years . ' years');
    }
}
