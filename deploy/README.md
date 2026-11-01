# Deploying Veneer

Veneer runs either on the IBM i, installed in the IFS and run in PASE, or off it, on Linux
or in Docker, connecting to the IBM i over the network. It ships as a self-contained
archive, `veneer-<version>.tar.gz`, or as a Docker image (see [Docker](#docker)). The archive holds the compiled server, the browser client and the
production dependencies, so the target needs only **Node.js 20.12 or later**: no compiler,
no `npm install`, and no internet access. Build it on a development machine:

```sh
npm ci
npm run package        # release/veneer-<version>.tar.gz and .sha256
```

Installs are laid out so that upgrades never touch configuration or customizations:

| | IBM i | Linux |
| --- | --- | --- |
| Program (one directory per version) | `/QOpenSys/opt/veneer/veneer-<version>` | `/opt/veneer/veneer-<version>` |
| Active version (symlink) | `/QOpenSys/opt/veneer/current` | `/opt/veneer/current` |
| Configuration | `/QOpenSys/etc/veneer/veneer.env` | `/etc/veneer/veneer.env` |
| Screen customizations | `/QOpenSys/etc/veneer/screens` | `/var/lib/veneer/screens` |
| Components, if used (`VENEER_COMPONENTS_DIR`) | `/QOpenSys/etc/veneer/components` | `/etc/veneer/components` |
| Recorded data (screen inventory) | `/QOpenSys/var/lib/veneer` | `/var/lib/veneer/data` |
| Logs | `/QOpenSys/var/log/veneer/veneer.log` | the systemd journal (`journalctl -u veneer`) |

The configuration file uses the same settings as `.env` in development; the archive
includes a commented `veneer.env.example`. At a minimum, set `VENEER_HOST`, `VENEER_PORT`
and `VENEER_TLS`. Also set `VENEER_LISTEN_HOST`; the default is 127.0.0.1, which only
accepts connections from the server itself. If other machines will connect, set
`VENEER_HTTPS_CERT` and `VENEER_HTTPS_KEY` too, so sign-on passwords are encrypted. The
file may contain the designer token, so make it readable only by the service.

For the designer, `VENEER_DESIGNER=local` lets a browser on the server itself, or one
connected through an SSH tunnel, use it without a token. Behind a reverse proxy, requests
are never treated as local. Other people need `VENEER_DESIGNER_TOKEN`. The admin page
(`/admin`, active sessions and recent errors) works the same way with `VENEER_ADMIN=local`
and `VENEER_ADMIN_TOKEN`; keep that token for operators only, since it can end anyone's
session.

After starting, check the server:

```sh
curl http://127.0.0.1:8080/healthz    # {"status":"ok","version":"0.1.0",...}
```

## Securing Veneer

Users type their IBM i passwords into Veneer, so treat it like any other sign-on server.
Veneer has no IBM i authority of its own: each browser tab is a telnet session, and users
sign on with their own profiles, as in any emulator. The same checklist applies whether
Veneer runs on the IBM i, from the IFS, or off it on Linux or in Docker. A secure install
does all of these:

- [ ] **Encrypt the IBM i connection.** `VENEER_TLS=true` and `VENEER_PORT=992` (the
  defaults), with the certificate checked: leave `VENEER_TLS_REJECT_UNAUTHORIZED` on, and
  set `VENEER_TLS_CA` for a certificate from the IBM i's own CA. Plain telnet is fine only
  when Veneer runs on the IBM i and connects to `localhost`. See
  [Veneer to the IBM i](#veneer-to-the-ibm-i).
- [ ] **Encrypt the browser connection.** Set `VENEER_HTTPS_CERT` and `VENEER_HTTPS_KEY`,
  or put a reverse proxy that handles HTTPS in front. See
  [Browsers to Veneer](#browsers-to-veneer).
- [ ] **Listen only where needed.** The default `VENEER_LISTEN_HOST=127.0.0.1` accepts
  connections from the server itself (and SSH tunnels) only. Use `0.0.0.0` only with
  HTTPS on, and use a firewall to limit who can reach the port.
- [ ] **Run as a service user with little authority.** On IBM i, the `VENEER` profile
  (`PASSWORD(*NONE)`, `USRCLS(*USER)`); on Linux, the `veneer` system user; in Docker, the
  image's `node` user. The program stays owned by an administrator, so the service can't
  change it.
- [ ] **Keep secrets readable only by the service.** The config file may hold tokens, and
  the HTTPS key file must not be readable by anyone else (`chmod 600`, owned by the service
  user). `veneer.sh` sets umask 027, so files Veneer creates aren't world-readable.
- [ ] **Lock down the designer and the admin page.** Leave `VENEER_DESIGNER` and
  `VENEER_ADMIN` unset, or `local`, unless people elsewhere need them. Then give them
  separate tokens of 12 characters or more. Designer code runs in every user's page and can
  read what they type, passwords included, so only trusted people should get that token.
- [ ] **Allow only your own pages.** Browsers from other sites can't connect unless their
  origin is in `VENEER_ALLOWED_ORIGINS`; leave it blank unless another site of yours embeds
  Veneer.
- [ ] **End idle sessions.** `VENEER_IDLE_TIMEOUT_MINUTES` (default 30) ends sessions left
  open, and `VENEER_MAX_SESSIONS` (default 100) caps how many devices Veneer can use.

Logs record who signed on (the IBM i user name) but never passwords or other field values.
`VENEER_TRACE=true` logs host records for diagnosis, but shows only the key and cursor of
what browsers send, never field values.

## TLS and HTTPS

Sign-on passwords cross two connections, and each needs its own encryption:

```
browser ──HTTPS/WSS──▶ Veneer ──TLS (port 992)──▶ IBM i
         VENEER_HTTPS_*          VENEER_TLS, VENEER_TLS_CA
```

Veneer doesn't create certificates. Whoever installs it provides them.

### Veneer to the IBM i

Set `VENEER_TLS=true` and `VENEER_PORT=992`. Veneer checks the IBM i's certificate:

- **It must be issued by a trusted authority.** A certificate from a public authority works
  as it is. For one from the IBM i's own local CA (made in Digital Certificate Manager),
  export that CA's certificate as a PEM file and set `VENEER_TLS_CA` to its path.
  `VENEER_TLS_CA` replaces Node's built-in list of authorities rather than adding to it.
- **It must name the host in `VENEER_HOST`.** Use the name the certificate was issued for,
  not an IP address or `localhost`, unless the certificate also covers those. If that name
  doesn't resolve where Veneer runs, add it to DNS or the host table: on the IBM i,
  `ADDTCPHTE`, or `CHGTCPHTE` to add a name to an existing address (127.0.0.1 when Veneer
  runs on the IBM i itself); elsewhere, `/etc/hosts`.

If the check fails, the browser shows "Host connection failed" and the log has the reason
in a `host connect failed` line, such as `self-signed certificate` or
`unable to verify the first certificate` (set `VENEER_TLS_CA`), or
`Hostname/IP does not match certificate's altnames` (change `VENEER_HOST`). Node's
suggestion in that message to use `--use-system-ca` doesn't apply; use `VENEER_TLS_CA`.

`VENEER_TLS_REJECT_UNAUTHORIZED=false` turns the check off. It still encrypts, but anyone
who can intercept the connection could impersonate the IBM i. Use it only to rule out
certificate problems while testing.

To see which certificate a host sends, and whether it verifies:

```sh
openssl s_client -connect myibmi.example.com:992 -servername myibmi.example.com </dev/null \
  | grep -E 'subject=|issuer=|Verify return code'
```

Telnet usually sends its local CA's certificate along with its own. If DCM is out of reach,
this saves the last certificate in the chain, which is the CA. Check that its fingerprint
(`openssl x509 -in ibmi-ca.pem -noout -fingerprint -sha256`) matches the CA in DCM before
trusting it:

```sh
openssl s_client -connect localhost:992 -showcerts </dev/null 2>/dev/null \
  | awk '/BEGIN CERT/ { pem = "" } { pem = pem $0 "\n" } /END CERT/ { last = pem } END { printf "%s", last }' \
  > /QOpenSys/etc/veneer/ibmi-ca.pem
```

On the IBM i, telnet over TLS needs a certificate assigned to the telnet server
(application `QIBM_QTV_TELNET_SERVER`) in Digital Certificate Manager, and
`CHGTELNA ALWSSL(*YES)`. Restart telnet afterwards (`ENDTCPSVR SERVER(*TELNET)` then
`STRTCPSVR SERVER(*TELNET)`), which ends active telnet sessions. Until a certificate is
assigned, port 992 still accepts connections but closes them at once: `openssl s_client`
shows `no peer certificate available`, not a certificate error. A certificate in the
*SYSTEM store isn't used until it is assigned. To see the assignments from SQL:

```sql
SELECT APPLICATION_ID, CERTIFICATE_LABELS FROM QSYS2.CERTIFICATE_USAGE_INFO
  WHERE APPLICATION_ID = 'QIBM_QTV_TELNET_SERVER'
```

When Veneer runs on the IBM i itself, plain telnet to `localhost` on port 23 never leaves
the machine, so it needs no TLS. Only the browser side does.

### Browsers to Veneer

Set `VENEER_HTTPS_CERT` and `VENEER_HTTPS_KEY` to a PEM certificate and its private key.
Veneer then serves HTTPS, and the 5250 traffic runs over secure WebSockets (WSS). The
certificate must name the host that users type in the browser. Options:

- **Your organization's certificate authority or a public one** for that host name.
- **A certificate already in Digital Certificate Manager.** Export it with its private key
  as a PKCS #12 file, then convert it:

  ```sh
  openssl pkcs12 -in veneer.p12 -clcerts -nokeys -out /QOpenSys/etc/veneer/cert.pem
  openssl pkcs12 -in veneer.p12 -nocerts -nodes -out /QOpenSys/etc/veneer/key.pem
  chown VENEER /QOpenSys/etc/veneer/key.pem && chmod 600 /QOpenSys/etc/veneer/key.pem
  ```

- **A reverse proxy** that handles HTTPS in front of Veneer, which then listens on
  127.0.0.1 only.

A self-signed certificate encrypts too, but every browser warns about it until it is
trusted. Keep the private key readable only by the service user.

### Local development

[mkcert](https://github.com/FiloSottile/mkcert) makes a `localhost` certificate that this
machine's browsers trust:

```sh
sudo apt install mkcert libnss3-tools    # or: brew install mkcert
mkcert -install                          # once: adds mkcert's CA to this machine and its browsers
mkdir -p ~/.local/share/veneer && cd ~/.local/share/veneer
mkcert -cert-file localhost.pem -key-file localhost-key.pem localhost 127.0.0.1 ::1
```

Then set `VENEER_HTTPS_CERT` and `VENEER_HTTPS_KEY` in `.env` to those two files and browse
to `https://localhost:8080`. `npm run dev` restarts when `.env` changes, which ends open
sessions.

## IBM i

You need Node.js from the IBM i open-source repositories: `yum install nodejs22` (or
`nodejs20`). Run the shell commands below in an SSH session (PASE), and the CL commands
from a 5250 command line.

### Install

1. Create a profile for the service. Users still sign on to their own 5250 sessions with
   their own profiles, so this profile needs no special authorities:

   ```
   CRTUSRPRF USRPRF(VENEER) PASSWORD(*NONE) USRCLS(*USER) TEXT('Veneer web server')
   ```

2. Unpack the archive and create the directories (PASE `tar` may not read gzip directly):

   ```sh
   mkdir -p /QOpenSys/opt/veneer /QOpenSys/etc/veneer/screens /QOpenSys/var/log/veneer /QOpenSys/var/lib/veneer
   cd /QOpenSys/opt/veneer
   gzip -dc /tmp/veneer-0.1.0.tar.gz | tar -xf -
   ln -sfn veneer-0.1.0 current
   cp current/veneer.env.example /QOpenSys/etc/veneer/veneer.env
   ```

3. Edit `/QOpenSys/etc/veneer/veneer.env`. For example:

   ```sh
   VENEER_HOST=localhost
   VENEER_PORT=23
   VENEER_TLS=false
   VENEER_LISTEN_HOST=0.0.0.0
   VENEER_HTTPS_CERT=/QOpenSys/etc/veneer/cert.pem
   VENEER_HTTPS_KEY=/QOpenSys/etc/veneer/key.pem
   VENEER_SCREENS_DIR=/QOpenSys/etc/veneer/screens
   VENEER_DATA_DIR=/QOpenSys/var/lib/veneer
   VENEER_LOG_FILE=/QOpenSys/var/log/veneer/veneer.log
   ```

   Running on the IBM i itself, Veneer can use plain Telnet to `localhost` without the
   password crossing the network. The browser side still needs HTTPS.

4. Give the service profile access:

   ```sh
   chown -R VENEER /QOpenSys/etc/veneer /QOpenSys/var/log/veneer /QOpenSys/var/lib/veneer
   chmod 700 /QOpenSys/etc/veneer
   ```

### Start and stop

With [Service Commander](https://github.com/ThePrez/ServiceCommander-IBMi) (recommended):

```sh
yum install service-commander
mkdir -p /QOpenSys/etc/sc/services
cp /QOpenSys/opt/veneer/current/deploy/ibmi/veneer.yaml /QOpenSys/etc/sc/services/
sc start veneer
sc check veneer
sc stop veneer
```

Or with CL commands. Node.js needs a multithreaded job (`ALWMLTTHD(*YES)`), and
`QP2SHELL2` runs it in the submitted job itself, so ending that job stops Veneer:

```
SBMJOB CMD(CALL PGM(QP2SHELL2) PARM('/QOpenSys/opt/veneer/current/deploy/ibmi/veneer.sh'))
       JOB(VENEER) USER(VENEER) JOBQ(QSYSNOMAX) ALWMLTTHD(*YES)

ENDJOB JOB(VENEER) OPTION(*CNTRLD) DELAY(30)
```

A controlled end sends Veneer `SIGTERM`. Veneer then ends its 5250 sessions, which
releases their devices, and exits.

### Start at IPL

Add the `SBMJOB` above (or `sc start veneer`, run through `QSH`) to the system startup
program. `DSPSYSVAL QSTRUPPGM` shows which program that is.

### If the job ends right away

`QP2SHELL2` ignores Node's exit status, so the job ends normally (end code 0) even when
Veneer could not start, and it leaves no job log. What Veneer printed is in a `QPRINT`
spooled file of the job: `WRKJOB JOB(nnnnnn/VENEER) OPTION(*SPLF)`, then display it.
The usual causes are a missing or invalid config file, and the listen port being in use.
Once Veneer has read its config, it writes everything to `VENEER_LOG_FILE` instead.
Without `VENEER_LOG_FILE`, every log line goes to that spooled file.

Submit the job to a queue such as `QSYSNOMAX`, not the default `QBATCH`. Veneer runs
until it is ended, and `QBATCH` often runs one job at a time, so it would hold up every
batch job queued after it.

## Linux

```sh
sudo useradd --system --home /var/lib/veneer --shell /usr/sbin/nologin veneer
sudo mkdir -p /opt/veneer /etc/veneer /var/lib/veneer/screens /var/log/veneer
sudo tar -xzf veneer-0.1.0.tar.gz -C /opt/veneer
sudo ln -sfn veneer-0.1.0 /opt/veneer/current
sudo cp /opt/veneer/current/veneer.env.example /etc/veneer/veneer.env
sudo chown -R veneer:veneer /var/lib/veneer /var/log/veneer
sudo chown root:veneer /etc/veneer/veneer.env && sudo chmod 640 /etc/veneer/veneer.env
# edit /etc/veneer/veneer.env; set VENEER_SCREENS_DIR=/var/lib/veneer/screens and VENEER_DATA_DIR=/var/lib/veneer/data
sudo cp /opt/veneer/current/deploy/linux/veneer.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now veneer
journalctl -u veneer -f
```

The unit expects `node` at `/usr/bin/node`; adjust `ExecStart` otherwise. The default port
is 8080. Ports below 1024 need `AmbientCapabilities=CAP_NET_BIND_SERVICE`, or a reverse
proxy in front.

## Docker

The image runs Veneer on Node.js 22 (Alpine) as a non-root user. It listens on port 8080,
keeps screen customizations in the `/data/screens` volume and what it records (the screen
inventory) in `/data/state`. Settings are the usual
`VENEER_*` environment variables; logs go to stdout (`docker logs`).

With Compose, from a checkout of the repository:

```sh
cp .env.example .env      # set VENEER_HOST, VENEER_PORT, VENEER_TLS
docker compose up --build -d
docker compose logs -f
```

`compose.yaml` reads `.env`, publishes port 8080, and mounts `./screens` as the
customizations folder so they can be committed to git. The container runs as user
`node` (uid 1000); if your user has a different uid, make `./screens` writable for 1000
(`sudo chown -R 1000 screens`) or the designer can't save.

Or build and run the image directly:

```sh
docker build -t veneer .
docker run -d --name veneer -p 8080:8080 \
  -e VENEER_HOST=myibmi.example.com -e VENEER_PORT=992 -e VENEER_TLS=true \
  -e VENEER_DESIGNER_TOKEN=a-long-secret-value \
  -v veneer-screens:/data/screens \
  veneer
```

Notes:

- **The designer needs `VENEER_DESIGNER_TOKEN` in Docker,** and the admin page
  `VENEER_ADMIN_TOKEN`. Through Docker's port mapping, browser requests arrive from the
  Docker network, not from 127.0.0.1, so `VENEER_DESIGNER=local` and `VENEER_ADMIN=local`
  don't apply.
- **HTTPS:** mount the certificate files and set `VENEER_HTTPS_CERT` and
  `VENEER_HTTPS_KEY`, or put a reverse proxy in front.
- `VENEER_HOST=localhost` means the container itself. Use the IBM i's name or address.
- The health check calls `/healthz` (`docker ps` shows the status). `docker stop` sends
  SIGTERM, and Veneer ends its 5250 sessions before exiting; Compose allows 15 seconds.
- To upgrade, rebuild (`docker compose up --build -d`); customizations stay in the volume.

## Upgrade and roll back

Unpack the new version next to the old one, point `current` at it, and restart. The
configuration, customizations and logs live outside the program directory, so nothing
needs copying.

```sh
cd /QOpenSys/opt/veneer                  # /opt/veneer on Linux
gzip -dc /tmp/veneer-0.2.0.tar.gz | tar -xf -
ln -sfn veneer-0.2.0 current
# restart: sc restart veneer, ENDJOB + SBMJOB, or systemctl restart veneer
```

To roll back, point `current` at the previous version and restart. Restarting ends the
users' sessions, so do it outside working hours.

## Uninstall

Stop the service. Remove it from the startup program (IBM i), or run
`systemctl disable veneer` and delete the unit file (Linux). Then delete the program,
configuration and log directories, and on IBM i run `DLTUSRPRF VENEER`.
