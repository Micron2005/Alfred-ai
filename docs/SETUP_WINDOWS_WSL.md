# Setup — Windows 11 + WSL2

This is the recommended setup for Alfred on your PC. You keep Windows as your main OS, and all the Linux-y AI tooling runs inside WSL2. Docker Desktop bridges the two.

## 1. Install WSL2 + Ubuntu

Open PowerShell **as Administrator** and run:

```powershell
wsl --install -d Ubuntu-22.04
```

Reboot when prompted. On first launch of Ubuntu, set a username and password. You're now in Linux land.

Verify it's WSL version 2:

```powershell
wsl -l -v
```

The `VERSION` column should say `2`. If it says `1`, run `wsl --set-version Ubuntu-22.04 2`.

## 2. Install Docker Desktop

Download from https://www.docker.com/products/docker-desktop/ and install it on Windows.

After installation, open **Docker Desktop → Settings → Resources → WSL Integration** and enable integration for your `Ubuntu-22.04` distro. This lets `docker` commands inside WSL use the Windows Docker Engine directly.

Verify from inside WSL:

```bash
docker run --rm hello-world
```

## 3. Install Ollama on Windows

Ollama handles the local LLM. Installing it on the Windows host (rather than inside WSL) gives it cleaner access to your AMD GPU via Vulkan/ROCm.

1. Download Ollama for Windows: https://ollama.com/download/windows
2. Install and launch. It runs as a background service on `localhost:11434`.
3. Pull the main model (this takes ~5 GB of disk):
   ```powershell
   ollama pull llama3.1:8b-instruct-q4_K_M
   ```
4. (Optional, recommended) pull a smaller fast model for quick replies:
   ```powershell
   ollama pull phi3.5:3.8b-mini-instruct-q4_K_M
   ```
5. Test it:
   ```powershell
   ollama run llama3.1:8b-instruct-q4_K_M "Hello Alfred, say something pithy."
   ```

### About your GPU

Your **MSI Radeon RX 5700 XT (8 GB)** is an RDNA1 card. Ollama's ROCm support for RDNA1 is imperfect — if you see it running CPU-only (slow), install the Vulkan-based build instead:

- Ollama's Vulkan backend: https://github.com/ollama/ollama/blob/main/docs/gpu.md
- Fallback: [LM Studio](https://lmstudio.ai) speaks the same OpenAI-compatible API and has great Vulkan support. Point `OLLAMA_HOST` at it.

A healthy run of `llama3.1:8b-instruct-q4_K_M` on your card should hit **20–40 tokens/sec**. If you see single-digit tokens/sec, it's falling back to CPU.

## 4. Clone Alfred and configure

From inside WSL:

```bash
cd ~
git clone https://github.com/<your-username>/alfred-ai.git
cd alfred-ai
cp .env.example .env
```

Edit `.env`:

- Leave `OLLAMA_HOST=http://host.docker.internal:11434` as-is. That resolves from inside Docker to the Windows host.
- If you want the coding fallback, paste your Anthropic key into `ANTHROPIC_API_KEY`.

## 5. Launch

```bash
docker compose up --build
```

First build takes a few minutes. Then:

- Open **http://localhost:3000** in your browser.
- Say "Hello Alfred."
- If the reply says *"LLM backend failed"*, Ollama isn't reachable — check that it's running on the Windows host and that `OLLAMA_HOST` matches.

## 6. Remote access via Tailscale

See [TAILSCALE.md](TAILSCALE.md).

## Troubleshooting

**Alfred replies but it's painfully slow.**
Ollama is likely running on CPU. Check the Ollama logs. Switch to its Vulkan build or use LM Studio.

**`docker compose up` says port 5432 already in use.**
You have another Postgres on that port. Either stop it (`sudo systemctl stop postgresql` on Linux) or change the mapping in `docker-compose.yml`.

**Next.js build fails with memory errors.**
Docker Desktop → Settings → Resources → give it at least 6 GB of RAM.

**`host.docker.internal` does not resolve from alfred-core.**
Some older Docker versions need `extra_hosts`. We already set this in `docker-compose.yml`. If it still fails, run `ip route show default | awk '{ print $3 }'` from inside a container — that's the Windows host IP; use it literally in `OLLAMA_HOST`.
