<?php
// Šablony e-mailů (src/node/lib/emails.js) – stejné texty a vzhled. Každá šablona vrací [subject, html, text].
namespace Mistenka;

defined('ABSPATH') || exit;

final class Emails
{
    private const MONTHS = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];
    // „Místo“ s neviditelným znakem (U+200C): Gmail jinak slovo považuje za obec Místo a udělá z něj odkaz na Google Mapy.
    private const NO_PLACE_LINK = "Mí\u{200C}sto";
    private const C = ['brand' => '#0075de', 'brandDark' => '#005bab', 'ink' => '#252321', 'muted' => '#6d6862', 'line' => '#e6e4e0', 'soft' => '#f6f5f4', 'okBg' => '#eef8f1', 'ok' => '#17803f', 'warnBg' => '#fff6e5', 'warn' => '#8a5a00'];
    private const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

    public static function esc($value): string
    {
        return htmlspecialchars(Js::str($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
    }

    public static function czDate(string $iso): string
    {
        [$y, $m, $d] = array_map('intval', explode('-', $iso));
        return "{$d}. " . self::MONTHS[$m - 1] . " {$y}";
    }

    public static function czk(int $halere): string
    {
        $amount = $halere / 100;
        $decimals = ($halere % 100) === 0 ? 0 : (($halere % 10) === 0 ? 1 : 2);
        return number_format($amount, $decimals, ',', "\u{00A0}") . "\u{00A0}Kč";
    }

    public static function czDateTime(string $iso): string
    {
        $date = Time::parse($iso);
        return $date ? $date->setTimezone(Time::prague())->format('j. n. Y H:i') : $iso;
    }

    private static function weekday(string $iso): string
    {
        return ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'][(int) (new \DateTimeImmutable($iso . ' 12:00:00', Time::utc()))->format('w')];
    }

    private static function huntingHours(array $revir, string $isoDate): string
    {
        $month = (int) substr($isoDate, 5, 2);
        foreach ($revir['fishingHours'] ?? [] as $rule) {
            if (in_array($month, $rule['months'] ?? [], true)) return $rule['from'] . '–' . $rule['to'];
        }
        return '';
    }

    // ---------- vzhled (tabulky a inline styly – Gmail, Outlook, mobily) ----------
    // Barva hlavičky podle typu zprávy: info modrá, success zelená (vystaveno, uloženo),
    // warning oranžová (upozornění, je potřeba něco udělat), danger červená (zrušeno, zadrženo, blokace).
    private const TONES = ['info' => ['#0075de', '#cfe5fb'], 'success' => ['#1a8245', '#d3f0dc'], 'warning' => ['#c2610c', '#fde3c8'], 'danger' => ['#c8302a', '#f9d2cf']];

    // Falešná banka (testovací web): každý e-mail nese varování, předmět začíná „[TEST]“.
    private const TEST_NOTE = 'Testovací verze Místenky – platby se jen simulují a vystavené místenky neopravňují k lovu.';
    private static bool $testMode = false;

    private static function layout(array $config, string $tone, string $title, string $rowsHtml, string $footerHtml = '', string $preheader = ''): string
    {
        $c = self::C;
        // layout() se vyhodnotí jako argument mail(), takže mail() pak ví, jestli jde o testovací verzi.
        self::$testMode = ($config['payment']['provider'] ?? '') === 'fake';
        $testHtml = self::$testMode ? '<p style="margin:0 0 18px;padding:12px 14px;background:' . $c['warnBg'] . ';border:1px solid #f3d9a4;border-radius:8px;font-size:14px;color:' . $c['warn'] . '"><b>' . self::esc(self::TEST_NOTE) . '</b></p>' : '';
        [$toneBg, $toneSub] = self::TONES[$tone] ?? self::TONES['info'];
        $org = $config['organization'];
        $contactParts = [];
        if (!empty($org['contact']['email'])) $contactParts[] = '<a href="mailto:' . self::esc($org['contact']['email']) . '" style="color:' . $c['muted'] . '">' . self::esc($org['contact']['email']) . '</a>';
        if (!empty($org['contact']['phone'])) $contactParts[] = self::esc($org['contact']['phone']);
        $contact = implode(' · ', $contactParts);
        $font = self::FONT;
        $pre = self::esc($preheader ?: $title);
        $t = self::esc($title);
        $short = self::esc($org['shortName']);
        $name = self::esc(($org['name'] ?? '') ?: $org['shortName']);
        return "<!doctype html><html lang=\"cs\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"color-scheme\" content=\"light\"><title>{$t}</title></head>
<body style=\"margin:0;padding:0;background:{$c['soft']};font-family:{$font};color:{$c['ink']};-webkit-text-size-adjust:100%\">
<span style=\"display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;mso-hide:all\">{$pre}</span>
<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"background:{$c['soft']}\"><tr><td align=\"center\" style=\"padding:24px 12px\">
<table role=\"presentation\" width=\"100%\" cellpadding=\"0\" cellspacing=\"0\" style=\"max-width:560px\">
<tr><td style=\"background:{$toneBg};border-radius:12px 12px 0 0;padding:18px 24px\">
  <span style=\"display:inline-block;width:28px;height:28px;line-height:28px;text-align:center;border-radius:7px;background:#fff;color:{$toneBg};font-weight:700;font-size:18px;vertical-align:middle\">⌁</span>
  <span style=\"color:#fff;font-size:18px;font-weight:700;vertical-align:middle;margin-left:8px\">Místenka</span>
  <span style=\"color:{$toneSub};font-size:13px;vertical-align:middle;margin-left:8px\">{$short}</span>
</td></tr>
<tr><td style=\"background:#fff;border:1px solid {$c['line']};border-top:0;border-radius:0 0 12px 12px;padding:28px 24px 24px\">
  {$testHtml}<h1 style=\"margin:0 0 16px;font-size:22px;line-height:1.25;color:{$c['ink']}\">{$t}</h1>
  <div style=\"font-size:15px;line-height:1.55\">{$rowsHtml}{$footerHtml}</div>
</td></tr>
<tr><td style=\"padding:16px 8px;color:{$c['muted']};font-size:12px;line-height:1.5;text-align:center\">
  {$name}" . ($contact ? "<br>{$contact}" : '') . "<br>Tato zpráva byla odeslána automaticky, neodpovídejte na ni.
</td></tr></table></td></tr></table></body></html>";
    }

    private static function table(array $rows): string
    {
        $c = self::C;
        $out = '';
        foreach ($rows as [$k, $v]) {
            $out .= '<tr><td style="padding:9px 12px 9px 0;color:' . $c['muted'] . ';border-bottom:1px solid ' . $c['line'] . ';width:42%;vertical-align:top">' . self::esc($k) . '</td><td style="padding:9px 0;font-weight:600;border-bottom:1px solid ' . $c['line'] . '">' . self::esc($v) . '</td></tr>';
        }
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px;font-size:14px">' . $out . '</table>';
    }

    // Mapa revíru (jen když je zakreslená): schematický náhled s odkazem na interaktivní mapu.
    // Místo lovu (podrevír místenky, jinak celý revír) zvýrazněné s GPS a odkazem na interaktivní mapu
    // (mapa jen jako odkaz – podklad Mapy.com se do e-mailu vkládat nesmí).
    private static function placeBlock(array $place, array $links): string
    {
        $c = self::C;
        $gps = $place['gps'] ? '<div style="font-size:14px;margin-top:6px">GPS <a href="' . self::esc(Config::mapyUrl($place['gps'])) . '" style="color:' . $c['brand'] . ';font-weight:600">' . self::esc(Config::gpsText($place['gps'])) . '</a></div>' : '';
        $map = !empty($links['map']) ? '<div style="font-size:14px;margin-top:6px"><a href="' . self::esc($links['map']) . '" style="color:' . $c['brand'] . ';font-weight:600">Interaktivní mapa revíru →</a> <span style="color:' . $c['muted'] . '">hranice podrevírů, parkování, WC</span></div>' : '';
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="background:#eef6fe;border:2px solid ' . $c['brand'] . ';border-radius:10px;padding:14px 18px">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:' . $c['muted'] . '">' . self::NO_PLACE_LINK . ' lovu</div>
  <div style="font-size:20px;font-weight:700;color:' . $c['brandDark'] . ';margin-top:4px">' . self::esc($place['title']) . '</div>' . $gps . $map . '
</td></tr></table>';
    }

    private static function placeText(array $place, array $links): array
    {
        $lines = ["Místo lovu: {$place['title']}"];
        if ($place['gps']) $lines[] = 'GPS: ' . Config::gpsText($place['gps']) . ' (' . Config::mapyUrl($place['gps']) . ')';
        if (!empty($links['map'])) $lines[] = "Mapa revíru: {$links['map']}";
        return $lines;
    }

    private static function button(string $href, string $label, bool $secondary = false): string
    {
        $c = self::C;
        return '<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px"><tr><td style="border-radius:8px;background:' . ($secondary ? '#fff' : $c['brand']) . ';' . ($secondary ? 'border:1px solid ' . $c['brand'] . ';' : '') . '"><a href="' . self::esc($href) . '" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:' . ($secondary ? $c['brand'] : '#fff') . ';text-decoration:none;border-radius:8px">' . self::esc($label) . '</a></td></tr></table>';
    }

    private static function highlight(string $label, string $value, string $sub = '', string $tone = 'brand'): string
    {
        $c = self::C;
        $bg = $tone === 'warn' ? $c['warnBg'] : ($tone === 'ok' ? $c['okBg'] : '#eef6fe');
        $color = $tone === 'warn' ? $c['warn'] : ($tone === 'ok' ? $c['ok'] : $c['brandDark']);
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px"><tr><td style="background:' . $bg . ';border-radius:10px;padding:16px 18px">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:' . $c['muted'] . '">' . self::esc($label) . '</div>
  <div style="font-size:28px;font-weight:700;letter-spacing:.12em;color:' . $color . ';margin-top:4px">' . self::esc($value) . '</div>' . ($sub !== '' ? '<div style="font-size:14px;color:' . $c['ink'] . ';margin-top:4px">' . self::esc($sub) . '</div>' : '') . '</td></tr></table>';
    }

    private static function checklist(array $items): string
    {
        $c = self::C;
        $out = '';
        foreach ($items as $item) $out .= '<tr><td style="width:22px;vertical-align:top;color:' . $c['ok'] . ';font-weight:700;padding:3px 0">✓</td><td style="padding:3px 0">' . self::esc($item) . '</td></tr>';
        return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;font-size:14px">' . $out . '</table>';
    }

    private static function note(string $text): string
    {
        $c = self::C;
        return '<p style="margin:0 0 16px;padding:12px 14px;background:' . $c['soft'] . ';border-radius:8px;font-size:13px;color:' . $c['muted'] . '">' . self::esc($text) . '</p>';
    }

    private static function text(array $lines): string
    {
        return implode("\n", array_filter($lines, fn($line) => $line !== null));
    }

    private static function rowsText(array $rows): array
    {
        return array_map(fn($r) => "{$r[0]}: {$r[1]}", $rows);
    }

    private static function mail(string $subject, string $html, string $text): array
    {
        if (self::$testMode) return ['subject' => "[TEST] {$subject}", 'html' => $html, 'text' => self::TEST_NOTE . "\n\n" . $text];
        return ['subject' => $subject, 'html' => $html, 'text' => $text];
    }

    private static function contactLine(array $config): string
    {
        $contact = $config['organization']['contact'] ?? [];
        return implode(', ', array_filter([$contact['email'] ?? '', $contact['phone'] ?? '']));
    }

    // Podrevír místenky (vybraný při nákupu), u starších místenek podrevíry revíru.
    private static function ticketSub(array $t, array $revir): ?array
    {
        if (!empty($t['subdistrict'])) return ['Podrevír', Config::subdistrictName($revir, $t['subdistrict'])];
        $label = Config::ticketSubdistrictLabel($revir);
        return $label ? [count($revir['ticketSubdistricts']) > 1 ? 'Podrevíry' : 'Podrevír', $label] : null;
    }

    // ---------- místenky ----------
    public static function paymentInstructions(array $config, array $x): array
    {
        $t = $x['ticket'];
        $revir = $x['revir'];
        $sub = self::ticketSub($t, $revir);
        $rows = array_merge([['Revír', $revir['name']]], $sub ? [$sub] : [], [['Datum lovu', self::weekday($t['fishing_date']) . ' ' . self::czDate($t['fishing_date'])]]);
        $rows = array_merge($rows, [['Číslo účtu', $config['payment']['accountNumber'] . '/' . $config['payment']['bankCode']], ['Variabilní symbol', $t['variable_symbol']], ['Zaplaťte do', self::czDateTime($t['reserved_until'])]]);
        $amount = self::czk($t['amount_due_halere']);
        return self::mail(
            "Místenka {$t['code']} – pokyny k platbě",
            self::layout($config, 'info', 'Dokončete platbu místenky', '<p style="margin:0 0 16px">' . self::NO_PLACE_LINK . ' na revíru <b>' . self::esc($revir['name']) . '</b> je pro vás rezervované. Místenku vystavíme hned po připsání platby a pošleme vám ji e-mailem.</p>
      ' . self::highlight('K úhradě', $amount, 'VS ' . $t['variable_symbol']) . self::table($rows) . self::button($x['links']['payment'], 'Zobrazit QR platbu') . '
      ' . self::note('Nejrychlejší je zaplatit načtením QR kódu v bankovní aplikaci – údaje se vyplní samy. Při ručním převodu nezapomeňte variabilní symbol.'), '', "Zaplaťte {$amount} do " . self::czDateTime($t['reserved_until']) . ", VS {$t['variable_symbol']}"),
            self::text(array_merge(['Dokončete platbu místenky.', "Částka: {$amount}"], self::rowsText($rows), ["QR platba: {$x['links']['payment']}"]))
        );
    }

    public static function ticketIssued(array $config, array $x): array
    {
        $t = $x['ticket'];
        $revir = $x['revir'];
        $sub = self::ticketSub($t, $revir);
        $place = Config::fishingPlace($revir, $t['subdistrict'] ?? null);
        $hours = self::huntingHours($revir, $t['fishing_date']);
        $day = self::weekday($t['fishing_date']) . ' ' . self::czDate($t['fishing_date']);
        $rows = [['Revír', implode(' · ', array_filter([$revir['name'], $revir['number'] ?? '']))]];
        if ($sub) $rows[] = $sub;
        $rows[] = ['Datum lovu', $day];
        if ($hours) $rows[] = ['Doba lovu', $hours];
        $rows[] = ['Rybář', "{$t['first_name']} {$t['last_name']}"];
        $rows[] = ['Číslo členské legitimace', $t['member_id']];
        $late = self::esc(Js::str($revir['lateReturnDays'] ?? ''));
        return self::mail(
            "Místenka {$t['code']} – {$revir['name']}, " . self::czDate($t['fishing_date']),
            self::layout($config, 'success', 'Vaše místenka je vystavena', self::highlight('Kód místenky', $t['code'], "{$day} · {$revir['name']}", 'ok') . self::placeBlock($place, $x['links']) . self::table($rows) . '
      ' . self::button($x['links']['ticket'], 'Zobrazit místenku a QR kód') . '
      <p style="margin:0 0 8px;font-weight:600">Než vyrazíte</p>' . self::checklist(['Platný rybářský lístek a povolenka – místenka je nenahrazuje.', 'Místenka v telefonu nebo vytištěná (QR kód pro kontrolu).', 'Každou ponechanou rybu ihned zapište do povolenky.']) . '
      <p style="margin:0 0 8px;font-weight:600">Po skončení lovu</p><p style="margin:0 0 8px">Místenku odevzdejte ještě týž den a zapište ponechané ryby (nebo „žádná ponechaná ryba“). Opožděně ji lze odevzdat do ' . $late . ' dnů, pak se uzavře jako neodevzdaná.</p>
      ' . self::button($x['links']['return'], 'Odevzdat místenku', true), '', "Kód {$t['code']} · {$day} · {$revir['name']}" . ($hours ? " · lov {$hours}" : '')),
            self::text(array_merge(['Vaše místenka je vystavena.', "Kód místenky: {$t['code']}"], self::placeText($place, $x['links']), self::rowsText($rows), ['Místenka nenahrazuje rybářský lístek ani povolenku.', "Místenka: {$x['links']['ticket']}", "Odevzdání po lovu: {$x['links']['return']}"]))
        );
    }

    public static function returnReminder(array $config, array $x): array
    {
        $t = $x['ticket'];
        $revir = $x['revir'];
        $deadline = self::czDateTime($x['deadline']);
        return self::mail(
            "Místenka {$t['code']} – nezapomeňte ji odevzdat",
            self::layout($config, 'warning', 'Odevzdejte prosím místenku', '<p style="margin:0 0 16px">Lov na revíru <b>' . self::esc($revir['name']) . '</b> dne ' . self::esc(self::czDate($t['fishing_date'])) . ' skončil a místenka <b>' . self::esc($t['code']) . '</b> ještě nebyla odevzdána.</p>
      ' . self::highlight('Odevzdejte nejpozději', $deadline, 'Odevzdání po dni lovu se označí jako opožděné.', 'warn') . self::button($x['links']['return'], 'Odevzdat místenku') . '
      ' . self::note('Po této lhůtě se místenka automaticky uzavře jako neodevzdaná, bez úlovku. Pokud jste si nic neponechali, zvolte při odevzdání „Žádná ponechaná ryba“.'), '', "Místenku {$t['code']} odevzdejte do {$deadline}"),
            self::text(["Místenka {$t['code']} ještě nebyla odevzdána.", "Odevzdání je možné do {$deadline} (opožděně). Poté se místenka automaticky uzavře jako neodevzdaná, bez úlovku.", "Odevzdat: {$x['links']['return']}"])
        );
    }

    public static function ticketClosed(array $config, array $x): array
    {
        $t = $x['ticket'];
        $revir = $x['revir'];
        $contactLine = self::contactLine($config);
        return self::mail(
            "Místenka {$t['code']} byla uzavřena jako neodevzdaná",
            self::layout($config, 'danger', 'Místenka byla uzavřena jako neodevzdaná', '<p>Místenku <b>' . self::esc($t['code']) . '</b> na revír ' . self::esc($revir['name']) . ' (den lovu ' . self::esc(self::czDate($t['fishing_date'])) . ') jste neodevzdali ani v prodloužené lhůtě. Byla proto automaticky uzavřena jako <b>neodevzdaná, bez zapsaného úlovku</b>.</p><p>Pokud jste na revíru něco ulovili nebo jde o omyl, kontaktujte prosím hospodáře' . ($contactLine ? ': ' . self::esc($contactLine) : '') . '.</p>'),
            self::text(["Místenka {$t['code']} ({$revir['name']}, " . self::czDate($t['fishing_date']) . ') byla automaticky uzavřena jako neodevzdaná, bez zapsaného úlovku.', 'Pokud jde o omyl, kontaktujte hospodáře' . ($contactLine ? ": {$contactLine}" : '') . '.'])
        );
    }

    // ---------- zadržení (B2) ----------
    public static function ticketSeized(array $config, array $x): array
    {
        $t = $x['ticket'];
        $revir = $x['revir'];
        $rows = [['Kód místenky', $t['code']], ['Revír', $revir['name']], ['Datum lovu', self::czDate($t['fishing_date'])], ['Zadrženo', self::czDateTime($t['seized_at'])], ['Důvod', $t['seized_reason']]];
        if (!empty($t['seized_place'])) $rows[] = [self::NO_PLACE_LINK, $t['seized_place']];
        $deadline = self::czDateTime($x['deadline']);
        return self::mail(
            "Místenka {$t['code']} byla zadržena rybářskou stráží",
            self::layout($config, 'danger', 'Místenka byla zadržena', '<p>Rybářská stráž zadržela vaši místenku. <b>Místenka od této chvíle neopravňuje k lovu.</b></p>' . self::table($rows) . '<p>Místenku musíte i tak odevzdat a zapsat všechny úlovky, nejpozději do <b>' . self::esc($deadline) . '</b>.</p>' . self::button($x['links']['return'], 'Odevzdat místenku')),
            self::text(array_merge(['Rybářská stráž zadržela vaši místenku. Místenka od této chvíle neopravňuje k lovu.'], self::rowsText($rows), ["Místenku musíte i tak odevzdat s úlovky do {$deadline}: {$x['links']['return']}"]))
        );
    }

    public static function seizureNotice(array $config, array $x): array
    {
        $t = $x['ticket'];
        $revir = $x['revir'];
        $rows = [['Kód místenky', $t['code']], ['Revír', $revir['name']], ['Datum lovu', self::czDate($t['fishing_date'])], ['Držitel', "{$t['first_name']} {$t['last_name']}"], ['Č. legitimace', $t['member_id']], ['Porybný', $x['wardenName']], ['Zadrženo', self::czDateTime($t['seized_at'])], ['Důvod', $t['seized_reason']]];
        if (!empty($t['seized_place'])) $rows[] = [self::NO_PLACE_LINK, $t['seized_place']];
        return self::mail(
            "Zadržená místenka {$t['code']} – {$t['first_name']} {$t['last_name']}",
            self::layout($config, 'warning', 'Porybný zadržel místenku', '<p>Pro informaci: místenka byla zadržena. Zadržení není potřeba potvrzovat.</p>' . self::table($rows) . self::button($x['links']['status'], 'Stav místenky')),
            self::text(array_merge(['Porybný zadržel místenku (není potřeba potvrzovat).'], self::rowsText($rows), ["Stav: {$x['links']['status']}"]))
        );
    }

    // ---------- limity úlovků (B3) ----------
    private static function limitLine(array $l): string
    {
        $period = ['day' => 'den', 'week' => 'týden', 'month' => 'měsíc'][$l['period']] ?? $l['period'];
        return "{$l['label']}: {$l['count']} ks za {$period} (limit {$l['maxCount']} ks" . ($l['period'] === 'day' ? '' : ', ' . self::czDate($l['from']) . ' – ' . self::czDate($l['to'])) . ')';
    }

    public static function limitExceeded(array $config, array $x): array
    {
        $t = $x['ticket'];
        $revir = $x['revir'];
        $rows = [['Kód místenky', $t['code']], ['Revír', $revir['name']], ['Datum lovu', self::czDate($t['fishing_date'])], ['Držitel', "{$t['first_name']} {$t['last_name']}"], ['Č. legitimace', $t['member_id']]];
        $items = implode('', array_map(fn($l) => '<li>' . self::esc(self::limitLine($l)) . '</li>', $x['limits']));
        return self::mail(
            "Překročený limit úlovků – {$t['first_name']} {$t['last_name']} ({$t['code']})",
            self::layout($config, 'warning', 'Překročený limit úlovků', '<p>Při odevzdání místenky byly podle místenek v Místence překročeny limity:</p><ul>' . $items . '</ul>' . self::table($rows) . '<p style="color:#5b6b64;font-size:13px">Místenka vidí jen úlovky ze svých místenek; limity platí na všech revírech svazu dohromady.</p>' . self::button($x['links']['status'], 'Stav místenky')),
            self::text(array_merge(['Překročené limity úlovků (podle místenek v Místence):'], array_map(fn($l) => '- ' . self::limitLine($l), $x['limits']), self::rowsText($rows), ["Stav: {$x['links']['status']}"]))
        );
    }

    public static function memberBlocked(array $config, array $x): array
    {
        $t = $x['ticket'];
        $block = $x['block'];
        $until = $block['until_date'] ? 'do ' . self::czDate($block['until_date']) : 'do odvolání';
        $limits = $x['limits'] ?? [];
        $email = $config['organization']['contact']['email'] ?? '';
        return self::mail(
            'Místenka – nákup místenek je pozastaven',
            self::layout($config, 'danger', 'Nákup místenek je pozastaven', '<p>Nákup místenek na číslo legitimace <b>' . self::esc($t['member_id']) . '</b> je pozastaven <b>' . self::esc($until) . '</b>.</p><p>Důvod: ' . self::esc($block['reason']) . '</p>' . ($limits ? '<ul>' . implode('', array_map(fn($l) => '<li>' . self::esc(self::limitLine($l)) . '</li>', $limits)) . '</ul>' : '') . '<p>Pokud jde o omyl, kontaktujte správce organizace' . ($email ? ' (' . self::esc($email) . ')' : '') . '.</p>'),
            self::text(["Nákup místenek na číslo legitimace {$t['member_id']} je pozastaven {$until}.", "Důvod: {$block['reason']}", 'Pokud jde o omyl, kontaktujte správce organizace.'])
        );
    }

    // ---------- uzávěrka sezony (B6) ----------
    public static function seasonReport(array $config, array $x): array
    {
        $data = $x['data'];
        $s = $data['summary'];
        $rows = [['Revír', $x['revir']], ['Období', self::czDate($data['from']) . ' – ' . self::czDate($data['to'])], ['Prodané místenky', (string) $s['sold']], ['Rybářů', (string) $s['anglers']], ['Tržby', self::czk((int) $s['revenueHalere'])], ['Odevzdané / neodevzdané', "{$s['returned']} / {$s['unreturned']}"], ['Úlovky', $data['catches']['total'] . ' ks, ' . Js::str($data['catches']['weightKg']) . ' kg'], ['Zarybnění', self::czk((int) $data['stocking']['costHalere'])]];
        return self::mail(
            "Uzávěrka – {$x['name']}",
            self::layout($config, 'success', "Uzávěrka: {$x['name']}", '<p>Sezona skončila, uzávěrka je vytvořená a uložená v manažerském portálu.</p>' . self::table($rows) . self::button($x['link'], 'Otevřít uzávěrku')),
            self::text(array_merge(["Uzávěrka: {$x['name']}"], self::rowsText($rows), ["Uzávěrka: {$x['link']}"]))
        );
    }

    // ---------- nastavení (B5) ----------
    // Hlášení chyby (všem adminům).
    public static function bugReport(array $config, array $x): array
    {
        $r = $x['report'];
        $who = $r['user'] ? "{$r['user']['name']} <{$r['user']['email']}>" : ($r['contactEmail'] ? "nepřihlášený, odpověď na {$r['contactEmail']}" : 'nepřihlášený uživatel');
        $rows = [['Hlášení', "#{$r['id']}"], ['Čas', self::czDateTime($r['createdAt'])], ['Nahlásil', $who], ['Stránka', $r['url'] ?: '—'], ['Snímek obrazovky', $r['hasScreenshot'] ? 'ano' : 'ne']];
        return self::mail(
            "Místenka – nahlášená chyba #{$r['id']}",
            self::layout($config, 'warning', 'Nahlášená chyba', '<p style="margin:0 0 16px;white-space:pre-wrap">' . self::esc($r['description']) . '</p>' . self::table($rows) . self::button($x['link'], 'Otevřít v portálu')),
            self::text(array_merge(['Nahlášená chyba', '', $r['description'], ''], self::rowsText($rows), ["Portál: {$x['link']}"]))
        );
    }

    public static function paymentSettingsChanged(array $config, array $x): array
    {
        $labels = ['accountNumber' => 'Číslo účtu', 'bankCode' => 'Kód banky', 'iban' => 'IBAN', 'recipientName' => 'Příjemce', 'reservationMinutes' => 'Rezervace (min)', 'messagePrefix' => 'Zpráva pro příjemce'];
        $rows = [];
        foreach ($labels as $key => $label) {
            $before = $x['before'][$key] ?? null;
            $after = $x['after'][$key] ?? null;
            if (Js::str($before) !== Js::str($after)) $rows[] = [$label, ($before === null ? '—' : Js::str($before)) . ' → ' . ($after === null ? '—' : Js::str($after))];
        }
        $at = self::czDateTime($x['at']);
        return self::mail(
            'Místenka – změněny platební údaje',
            self::layout($config, 'warning', 'Změněny platební údaje', '<p>' . self::esc($x['actorName']) . ' změnil(a) ' . self::esc($at) . ' platební údaje Místenky. Nové objednávky se platí podle nových údajů.</p>' . self::table($rows ?: [['Změna', 'beze změny hodnot']]) . '<p><b>Pokud o změně nevíte, okamžitě ji prověřte</b> – změna účtu je nejčastější podvod.</p>'),
            self::text(array_merge(["{$x['actorName']} změnil(a) {$at} platební údaje Místenky."], self::rowsText($rows), ['Pokud o změně nevíte, okamžitě ji prověřte.']))
        );
    }

    // ---------- zrušení správcem (B4) ----------
    public static function ticketCancelled(array $config, array $x): array
    {
        $t = $x['ticket'];
        $revir = $x['revir'];
        $contact = self::contactLine($config);
        $rows = [['Kód místenky', $t['code']], ['Revír', $revir['name']], ['Datum lovu', self::czDate($t['fishing_date'])], ['Důvod', $t['cancel_reason']]];
        return self::mail(
            "Místenka {$t['code']} byla zrušena",
            self::layout($config, 'danger', 'Místenka byla zrušena', '<p>Správce organizace vaši místenku zrušil. <b>Místenka neplatí a neopravňuje k lovu.</b></p>' . self::table($rows) . '<p>Pokud máte nárok na vrácení peněz, vyřídí ho správce převodem' . ($contact ? '; kontakt: ' . self::esc($contact) : '') . '.</p>'),
            self::text(array_merge(['Správce organizace vaši místenku zrušil. Místenka neplatí a neopravňuje k lovu.'], self::rowsText($rows), ['Vrácení peněz vyřídí správce' . ($contact ? " ({$contact})" : '') . '.']))
        );
    }

    // ---------- oprava úlovků správcem ----------
    private static function catchesText(array $part): string
    {
        if (!empty($part['noCatch'])) return 'nic neponecháno';
        $cz = fn($n) => str_replace('.', ',', Js::str($n));
        $out = implode(', ', array_map(fn($c) => "{$c['species']} " . $cz($c['length']) . ' cm' . (!empty($c['weight']) ? ' · ' . $cz($c['weight']) . ' kg' : ''), $part['catches'] ?? []));
        return $out !== '' ? $out : '—';
    }

    public static function catchesCorrected(array $config, array $x): array
    {
        $t = $x['ticket'];
        $revir = $x['revir'];
        $contact = self::contactLine($config);
        $rows = [['Kód místenky', $t['code']], ['Revír', $revir['name']], ['Datum lovu', self::czDate($t['fishing_date'])], ['Důvod opravy', $x['reason']], ['Původně', self::catchesText($x['before'])], ['Nově', self::catchesText($x['after'])]];
        $disagree = 'Pokud s opravou nesouhlasíte, ozvěte se hospodáři' . ($contact ? " ({$contact})" : '') . '.';
        return self::mail(
            "Místenka {$t['code']} – správce opravil úlovky",
            self::layout($config, 'info', 'Správce opravil úlovky', '<p>Správce organizace opravil úlovky, které jste uvedl/a při odevzdání místenky. Místenka zůstává odevzdaná, nic dalšího dělat nemusíte.</p>' . self::table($rows) . '<p>' . self::esc($disagree) . '</p>'),
            self::text(array_merge(['Správce organizace opravil úlovky, které jste uvedl/a při odevzdání místenky. Místenka zůstává odevzdaná.'], self::rowsText($rows), [$disagree]))
        );
    }

    // ---------- mimořádné uzavření (B4) ----------
    public static function closureNotice(array $config, array $x): array
    {
        $t = $x['ticket'];
        $revir = $x['revir'];
        $closure = $x['closure'];
        $range = $closure['dateFrom'] === $closure['dateTo'] ? self::czDate($closure['dateFrom']) : self::czDate($closure['dateFrom']) . ' – ' . self::czDate($closure['dateTo']);
        $contact = self::contactLine($config);
        $rows = [['Kód místenky', $t['code']], ['Revír', $revir['name']], ['Datum lovu', self::czDate($t['fishing_date'])], ['Uzavřeno', $range], ['Důvod', $closure['reason']]];
        return self::mail(
            "Revír {$revir['name']} je mimořádně uzavřen – místenka {$t['code']}",
            self::layout($config, 'warning', 'Revír je mimořádně uzavřen', '<p>Na den vaší místenky je revír mimořádně uzavřen. <b>Lovit v tento den nelze.</b></p>' . self::table($rows) . '<p>Ohledně vrácení peněz nebo náhradního termínu kontaktujte prosím správce' . ($contact ? ': ' . self::esc($contact) : '') . '.</p>' . self::button($x['links']['status'], 'Stav místenky')),
            self::text(array_merge(['Revír je na den vaší místenky mimořádně uzavřen. Lovit v tento den nelze.'], self::rowsText($rows), ['Vrácení peněz nebo náhradní termín: kontaktujte správce' . ($contact ? " ({$contact})" : '') . '.']))
        );
    }

    // ---------- žádost „Jsem porybný“ ----------
    public static function wardenRequest(array $config, array $x): array
    {
        $rows = [['Žadatel', $x['name']], ['E-mail', $x['email']], ['Č. legitimace', $x['memberId'] ?: '—']];
        if ($x['note'] !== '') $rows[] = ['Poznámka', $x['note']];
        $l = $x['links'];
        return self::mail(
            "Žádost o funkci porybného – {$x['name']}",
            self::layout($config, 'info', 'Žádost o funkci porybného', '<p>Uživatel Místenky uvádí, že je porybný (rybářská stráž MO nebo státní rybářská stráž), a žádá o funkci porybného v aplikaci. Po schválení uvidí při kontrole místenky plné údaje a bude moct místenku zadržet.</p>' . self::table($rows) . '
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px"><tr><td style="padding-right:8px">' . self::button($l['approve'], 'Schválit') . '</td><td>' . self::button($l['reject'], 'Zamítnout', true) . '</td></tr></table>
      <p style="margin:0 0 16px"><a href="' . self::esc($l['open']) . '" style="color:' . self::C['brand'] . '">Otevřít notifikace v portálu</a></p>
      ' . self::note('Tlačítka otevřou stránku s potvrzením rozhodnutí. Odkaz platí 7 dní a lze ho použít jen jednou; žádost můžete vyřídit i v portálu (Notifikace).'), '', "{$x['name']} žádá o funkci porybného"),
            self::text(array_merge(['Žádost o funkci porybného.'], self::rowsText($rows), ["Schválit: {$l['approve']}", "Zamítnout: {$l['reject']}", "Portál: {$l['open']}"]))
        );
    }

    public static function wardenRequestDecided(array $config, bool $approved, string $note, string $link): array
    {
        $title = $approved ? 'Funkce porybného schválena' : 'Žádost o funkci porybného zamítnuta';
        $intro = $approved
            ? 'Vaše žádost byla schválena. Po přihlášení uvidíte při kontrole místenky plné údaje rybáře a můžete místenku zadržet.'
            : 'Vaše žádost o funkci porybného nebyla schválena. Pokud jde o omyl, kontaktujte správce organizace.';
        return self::mail(
            'Místenka – ' . mb_strtolower($title, 'UTF-8'),
            self::layout($config, ($approved ? 'success' : 'info'), $title, '<p>' . self::esc($intro) . '</p>' . ($note !== '' ? self::table([['Poznámka správce', $note]]) : '') . ($approved ? self::button($link, 'Otevřít Místenku') : '')),
            self::text([$title, $intro, $note !== '' ? "Poznámka správce: {$note}" : null, $approved ? $link : null])
        );
    }

    // ---------- účty ----------
    private static function validFor(int $minutes): string
    {
        return $minutes >= 120 ? round($minutes / 60) . ' hodin' : "{$minutes} minut";
    }

    private static function accountMail(array $config, string $subject, string $title, string $intro, ?string $link = null, string $label = '', ?int $minutes = null, ?string $outro = null): array
    {
        $note = $minutes ? 'Odkaz platí ' . self::validFor($minutes) . ' a lze ho použít jen jednou.' : '';
        $outroText = $outro ?: 'Pokud jste o nic nežádali, zprávu ignorujte.';
        return self::mail(
            $subject,
            self::layout($config, 'info', $title, '<p>' . self::esc($intro) . '</p>' . ($link ? self::button($link, $label) : '') . ($note ? '<p style="color:#5b6b64;font-size:13px">' . self::esc($note) . '</p>' : '') . '<p style="color:#5b6b64;font-size:13px">' . self::esc($outroText) . '</p>'),
            self::text([$title, $intro, $link ? "{$label}: {$link}" : null, $note ?: null, $outroText])
        );
    }

    public static function accountVerify(array $config, string $link, int $minutes): array
    {
        return self::accountMail($config, 'Místenka – potvrďte registraci', 'Potvrďte svůj e-mail', 'Děkujeme za registraci. Účet aktivujete kliknutím na tlačítko níže.', $link, 'Potvrdit e-mail', $minutes);
    }

    public static function accountExists(array $config, string $link): array
    {
        return self::accountMail($config, 'Místenka – účet už existuje', 'Účet s tímto e-mailem už máte', 'Někdo (pravděpodobně vy) se pokusil znovu zaregistrovat s tímto e-mailem. Přihlaste se, případně si nechte poslat odkaz pro přihlášení nebo obnovu hesla.', $link, 'Přihlásit se');
    }

    public static function magicLink(array $config, string $link, int $minutes): array
    {
        return self::accountMail($config, 'Místenka – odkaz pro přihlášení', 'Přihlášení do Místenky', 'Kliknutím na tlačítko se přihlásíte bez hesla.', $link, 'Přihlásit se', $minutes);
    }

    public static function passwordReset(array $config, string $link, int $minutes): array
    {
        return self::accountMail($config, 'Místenka – obnova hesla', 'Nastavte si nové heslo', 'Obdrželi jsme žádost o obnovu hesla k vašemu účtu.', $link, 'Nastavit nové heslo', $minutes);
    }

    public static function emailChange(array $config, string $link, int $minutes): array
    {
        return self::accountMail($config, 'Místenka – potvrďte nový e-mail', 'Potvrďte změnu e-mailu', 'Tuto adresu jste zadali jako nový e-mail svého účtu. Změna se projeví po potvrzení.', $link, 'Potvrdit nový e-mail', $minutes);
    }

    public static function staffInvite(array $config, string $link, int $minutes, string $roleLabel): array
    {
        return self::accountMail($config, "Místenka – pozvánka do správy ({$roleLabel})", 'Pozvánka do správy Místenky', "Byli jste pozváni jako {$roleLabel} organizace {$config['organization']['shortName']}. Kliknutím na tlačítko si nastavíte heslo a přihlásíte se.", $link, 'Nastavit heslo', $minutes, 'Pokud pozvánku nečekáte, zprávu ignorujte – bez nastavení hesla se účet nepoužije.');
    }

    public static function accountDeleted(array $config): array
    {
        return self::accountMail($config, 'Místenka – účet byl smazán', 'Váš účet byl smazán', 'Účet a jeho přihlašovací údaje jsme smazali. Vystavené místenky uchováváme po dobu stanovenou pro evidenci, už ale nejsou spojené s účtem.', null, '', null, 'Pokud jste účet nemazali vy, kontaktujte prosím organizaci.');
    }
}
