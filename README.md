# Mulqi Auto Continue

Plugin event untuk DeepSeek Harness (DSH) yang membuat percakapan **melanjutkan
dirinya sendiri saat gagal**, tanpa mengulang pekerjaan yang sudah selesai.

Gangguan jaringan di tengah percakapan, rate limit, galat server, timeout, atau
respons kosong biasanya berakhir sebagai turn yang mati setelah retry bawaan
habis. Exception dari tool/ekstensi juga langsung menutup turn. Plugin ini
menyambung kembali di dua tingkat, dengan batas yang jelas, bisa dibatalkan, dan
selalu meninggalkan jejak.

## Cara kerja

Ada dua lapisan yang bekerja bersama. Keduanya **selalu memprioritaskan mekanisme
pemulihan yang sudah ada** — plugin ini tidak pernah bersaing dengan
`dsh-llm-retry` atau kebijakan milik provider.

### Lapisan 1 — fallback per-request model (`agent/request-error` waterfall)

- Listener **selalu memanggil `next()` lebih dulu**. Kalau handler lain
  (biasanya `dsh-llm-retry` dengan policy provider-nya) sudah mengembalikan
  `{ kind: 'retry' }`, keputusan itu diteruskan apa adanya; plugin tidak ikut
  campur.
- Plugin hanya mengambil alih ketika kegagalan **akan menjadi terminal**:
  mencatat satu plugin-record durable `plugin:mulqi-auto-continue/retry` lewat
  `appendPluginRecord()` (event `ignorable` — di luar permukaan yang dilihat model),
  menunggu dengan
  exponential backoff (mulai 1 dtk, plafon 30 dtk, berjitter; kalau provider
  mengirim `providerRetryAfterMs` nilai itu yang dipakai), lalu mengembalikan
  `{ kind: 'retry' }` sehingga **turn dan step yang sama** lanjut di tempat.
- Setiap `(agent, turn, step)` dibatasi 3 fallback (bisa diatur). Lewat batas,
  kegagalan dibiarkan terminal dan diserahkan ke lapisan 2.
- Hanya kode gagal yang aman untuk diulang yang disentuh:
  `EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`.
- Kode terminal tidak pernah diulang — mengulangnya hanya membakar budget:
  `AUTH / INVALID_CREDENTIAL / QUOTA / ACCOUNT_QUOTA /
  CONTEXT_WINDOW_EXCEEDED / NO_ADAPTER / IMAGE_OFFLOAD_REQUIRED /
  BAD_REQUEST / CANCELED`.
- Penantian bisa dibatalkan oleh signal turn **maupun** signal lifetime plugin;
  batal = terminal.
- Kalau counter sempat naik lalu step itu berhasil (`step/end`), counter
  di-reset sehingga langkah berikutnya punya jatah penuh lagi.

### Lapisan 2 — penyambungan per-turn (`turn/end` sebagai fakta sesi)

Ketika sebuah turn tetap ditutup dengan `reason.kind === 'error'` (exception
ekstensi, budget habis, dan seterusnya):

- Plugin mengantrekan **satu** pesan lanjutan yang terlihat lewat
  `agent.followup()`, dengan sumber pesan yang dideklarasikan plugin sendiri:
  `{ kind: 'mulqi-auto-continue', plugin, attempt }`. Harness tidak punya kind `plugin` serbaguna — tiap produsen
  mendeklarasikan kind-nya sendiri, dan konsumen meneruskan kind tak dikenal.
  Di UI pesan ini tampil sebagai baris konteks berlabel `mulqi-auto-continue`,
  bukan sebagai pesan manusia, jadi tidak memalsukan penulisnya. Turn baru melanjutkan
  pekerjaan yang belum selesai.
- Secara default hanya untuk **root agent**; aktifkan `turn.includeSubagents`
  kalau subagent juga perlu disambung.
- Setiap rangkaian galat (streak) dibatasi 2 penyambungan, dengan jeda dingin
  30 detik antar-percobaan; turn yang selesai normal me-reset streak dan counter.
- Sebelum mengantre, plugin memeriksa ulang: agent masih hidup
  (`ctx.agents.get(id) === agent`), masih `idle`, dan sesinya tidak berubah.
  Kalau tidak, penyambungan dibatalkan tanpa noise.
- State per-agent dibuang saat `agent/disposed`; unload plugin membatalkan semua
  timer yang tertunda.

Semua aksi meninggalkan jejak: lapisan 1 menulis event
`plugin:mulqi-auto-continue/retry`, lapisan 2 mengirim pesan yang terlihat di transcript,
dan keduanya menulis log berprefiks `mulqi-auto-continue:`.

## Konfigurasi

Semua kunci opsional. Kunci yang tidak dikenal **ditolak** dengan menyebut nama
kuncinya, supaya typo tidak diam-diam mematikan pengaman.

```yaml
- insert:
    - id: mulqi-auto-continue
      name: mulqi-auto-continue
      config:
        request:
          enabled: true
          maxRetries: 3
          initialDelayMs: 1000
          maxDelayMs: 30000
          codes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
        turn:
          enabled: true
          maxRestarts: 2
          delayMs: 2000
          cooldownMs: 30000
          includeSubagents: false
          codes: null        # null = codes request + UNKNOWN
          message: "..."     # placeholder: {code} {message} {attempt}
```

| Kunci | Default | Arti |
|---|---|---|
| `request.enabled` | `true` | Nyalakan lapisan 1. |
| `request.maxRetries` | `3` | Fallback maksimum per `(agent, turn, step)`. |
| `request.initialDelayMs` | `1000` | Titik awal backoff. |
| `request.maxDelayMs` | `30000` | Plafon backoff (juga plafon untuk hint provider). |
| `request.codes` | 5 kode di atas | Allow-list kode yang boleh diulang. |
| `turn.enabled` | `true` | Nyalakan lapisan 2. |
| `turn.maxRestarts` | `2` | Penyambungan maksimum per error streak. |
| `turn.delayMs` | `2000` | Jeda sebelum pesan lanjutan diantrekan. |
| `turn.cooldownMs` | `30000` | Jeda dingin minimum antar-penyambungan per agent. |
| `turn.includeSubagents` | `false` | Ikut menyambung subagent, bukan hanya root agent. |
| `turn.codes` | `null` | `null` = `request.codes` + `UNKNOWN`. |
| `turn.message` | teks bawaan | Template pesan; placeholder `{code}`, `{message}`, `{attempt}`. |

Nilai yang tidak valid (integer negatif, plafon lebih kecil dari titik awal,
daftar kosong, duplikat, atau kode terminal di allow-list) membuat plugin gagal
mount dengan pesan yang jelas — bukan diam-diam berjalan setengah aktif.

## Instalasi

Sebagai paket bundle profile:

```bash
dsh plugin --profile <nama-profil> add /path/ke/mulqi-auto-continue
```

`package.json` mendeklarasikan `dsh.bundle.patch`, jadi `cordis.patch.yml` ikut
terpasang otomatis.

Atau manual, tambahkan baris yang sama ke layer pengguna
`cordis.patch.yml` milik profil:

```yaml
- insert:
    - id: mulqi-auto-continue
      name: mulqi-auto-continue
      config: {}
```

Nama paket diresolusikan lewat `node_modules` walk biasa, jadi direktori paket
boleh berada di `node_modules` profil maupun di fallback bersama
`$DSH_HOME/profiles/node_modules`.

## Verifikasi

```bash
npx vitest run --config vitest.config.js
```

32 test menutup kedua lapisan: pass-through downstream, penulisan event durable,
allow-list kode, batas retry, reset counter, pembatalan saat menunggu,
rejection downstream, penyambungan root agent, penolakan subagent (dan opt-in-nya),
non-error turn, batas streak, jeda dingin, agent sibuk/tergantikan, warning saat
`followup` melempar, serta pembuangan state dan disposer yang bersih.

## Lisensi

Mulqizamzam. Lihat `LICENSE`.
