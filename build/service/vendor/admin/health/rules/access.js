export function portsClosed({ params }) {
  if (!params || !params.alertToOpenPorts) return null;
  return {
    id: "ports-closed",
    severity: "warning",
    topic: "access",
    title: "Your router is not forwarding the ports your clients need",
    why: "Without open peer-to-peer ports your clients find fewer peers, which makes them slower to follow the chain and can cost attestations.",
    fix: { kind: "steps", label: "How to open the ports" },
    steps: [
      "Turn on UPnP in your router's settings; your AVADO then opens the ports itself.",
      "If your router has no UPnP, forward the peer-to-peer ports shown on each client's Overview tab to your AVADO's internal IP.",
      "Come back here after a few minutes: this check refreshes on its own.",
    ],
  };
}

export function noUpnp({ params }) {
  if (!params || params.upnpAvailable !== false) return null;
  return {
    id: "no-upnp",
    severity: "info",
    topic: "access",
    title: "UPnP is not available on your router",
    why: "UPnP lets your AVADO open the ports it needs by itself. Without it you forward them by hand, once.",
    fix: { kind: "link", to: "/help/access", label: "Read how" },
    dismissable: true,
  };
}

export function noNatLoopback({ params }) {
  if (!params || !params.noNatLoopback) return null;
  return {
    id: "no-nat-loopback",
    severity: "info",
    topic: "access",
    title: "Use the internal address at home",
    // The core sends `internalip` (DAPPMANAGER getParams); `internalIp` is the old spelling.
    why: `Your router does not route its public address back into your network. When you are at home, reach your AVADO at ${params.internalip || params.internalIp || "its internal IP"} or my.ava.do.`,
    fix: null,
    dismissable: true,
  };
}

export function remoteAccessMissing({ packages }) {
  const names = new Set((packages || []).map(p => p && p.name));
  if (names.has("remoteconnect.avado.dnp.dappnode.eth") || names.has("vpn.dnp.dappnode.eth")) return null;
  return {
    id: "remote-access-missing",
    severity: "info",
    topic: "access",
    title: "Set up remote access",
    why: "Remote Connect lets you check on your AVADO when you are away from home.",
    fix: { kind: "link", to: "/installer/remoteconnect.avado.dnp.dappnode.eth", label: "Install Remote Connect" },
    dismissable: true,
  };
}
