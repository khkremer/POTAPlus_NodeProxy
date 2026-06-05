# POTAPlus Connector

A local HTTP proxy that bridges the [POTAPlus](https://dwestbrook.net/projects/potaplus/) Chrome plug-in via the [Log4OM](https://www.log4om.com/) interface to [RUMlogNG](https://www.dl2rum.de/rumsoft/RUMLog.html) for [POTA (Parks On The Air)](https://parksontheair.com/) activations.

## How It Works

POTAPlus (via the Log4OM API) is configured to send QSO data to this server via HTTP. The server reformats it as ADIF and broadcasts it over UDP to RUMlogNG using the N1MM protocol. It also optionally controls radio hardware via [hamlib](https://hamlib.github.io/)'s `rigctl`.

## Setup

```bash
npm install
```

Edit the configuration variables at the top of `POTAPlusConnector.js`:

| Variable | Description |
|---|---|
| `port` | HTTP listen port (default: `8073`) |
| `device` | rigctl radio address (e.g. `10.0.1.5:4532`) |
| `radio` | hamlib radio model number |
| `N1MM_Addr` | UDP broadcast address for RUMlogNG (e.g. `10.0.1.255`) |
| `N1MM_Port` | UDP port for RUMlogNG (default: `5555`) |
| `logFileName` | ADIF log output path (default: `./adif.log`) |

## Running

```bash
node POTAPlusConnector.js
```

Or in a detached screen session:

```bash
./doit.sh
```

The server listens on port `8073`.

## Log4OM Configuration

Point Log4OM's external logger at:

```
http://localhost:8073/log4om/log
```

To verify the server is reachable:

```
http://localhost:8073/log4om/ping
```

## Radio Control

The `/omnirig/qsy` endpoint tunes the radio via rigctl:

```
http://localhost:8073/omnirig/qsy?freq=7040000&mode=CW
```

Requires `rigctl` installed at `/usr/local/bin/rigctl` and a running hamlib daemon accessible at the configured `device` address.
