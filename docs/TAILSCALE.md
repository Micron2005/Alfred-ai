# Remote access with Tailscale

Goal: reach your home Alfred from your laptop or phone anywhere in the world, without opening ports on your router, without a VPS, and without dealing with TLS certificates.

[Tailscale](https://tailscale.com) is a zero-config mesh VPN. Free tier includes 100 devices and 3 users — more than you'll ever need for a personal assistant.

## Install

1. Sign up at https://login.tailscale.com/start with your GitHub or Google account.
2. Install the client:
   - **Windows PC** (the one running Alfred): https://tailscale.com/download/windows
   - **Your laptop**: same page, pick the right OS.
   - **Phone**: App Store / Play Store → "Tailscale".
3. Log in on each device with the same account.

## Reach Alfred

After installation, your PC has a stable Tailscale IP (something like `100.x.y.z`) and a MagicDNS name (e.g. `your-pc.your-tailnet.ts.net`).

From your laptop, anywhere in the world:

```
http://your-pc.your-tailnet.ts.net:3000
```

That's it. The traffic goes over Tailscale's encrypted tunnel, peer-to-peer when possible.

## (Optional) Pretty HTTPS via Tailscale Serve

If you want `https://alfred.your-tailnet.ts.net` instead of an IP + port:

```bash
tailscale serve --bg --https=443 http://localhost:3000
```

Tailscale provisions a real Let's Encrypt cert for you, valid only inside your tailnet. Nice for the phone app later.

## Don't want to keep the PC on 24/7?

If you're willing to lose always-available access, you can:

- Use [Wake-on-LAN](https://learn.microsoft.com/en-us/windows-hardware/drivers/network/wake-on-lan-overview) to wake the PC from sleep when you ping it from your laptop.
- Or put just the chat history database and the lightweight orchestrator on a small always-on device (e.g. a Raspberry Pi 5 on your Tailnet), and have it wake the GPU-equipped PC when needed.

For Phase 1, simplest is: leave the PC on, install Tailscale, done.

## Security notes

- Nothing is exposed to the public internet. Tailscale traffic is fully encrypted and only reachable from devices you've logged into.
- The `CORSMiddleware` is currently set to `allow_origins=["*"]` for ease of local development. If you ever expose Alfred publicly (say, via `tailscale funnel` to friends), tighten this to your specific hostnames in `alfred-core/src/alfred_core/main.py`.
