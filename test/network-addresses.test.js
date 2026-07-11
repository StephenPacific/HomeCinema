import assert from "node:assert/strict";
import test from "node:test";
import { lanAddressCandidates } from "../src/networkAddresses.js";

const ipv4 = (address) => ({ address, family: "IPv4", internal: false });

test("Windows Wi-Fi is recommended ahead of virtual adapters", () => {
  const candidates = lanAddressCandidates(
    {
      "VMware Network Adapter VMnet1": [ipv4("192.168.26.1")],
      "vEthernet (Default Switch)": [ipv4("172.22.224.1")],
      "Wi-Fi": [ipv4("192.168.20.37")]
    },
    4173
  );

  assert.deepEqual(candidates.map(({ address }) => address), ["192.168.20.37", "172.22.224.1", "192.168.26.1"]);
  assert.equal(candidates[0].recommended, true);
  assert.equal(candidates[0].interfaceName, "Wi-Fi");
});

test("physical Ethernet and macOS interfaces rank ahead of VPN and bridge addresses", () => {
  const candidates = lanAddressCandidates(
    {
      utun4: [ipv4("100.64.0.2")],
      bridge0: [ipv4("192.168.64.1")],
      en1: [ipv4("192.168.20.8")],
      Ethernet: [ipv4("10.0.0.18")]
    },
    4173
  );

  assert.deepEqual(candidates.slice(0, 2).map(({ interfaceName }) => interfaceName), ["Ethernet", "en1"]);
});

test("loopback and self-assigned IPv4 addresses are not advertised", () => {
  const candidates = lanAddressCandidates(
    {
      Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      "Wi-Fi": [ipv4("169.254.8.9")]
    },
    4173
  );

  assert.deepEqual(candidates, []);
});
