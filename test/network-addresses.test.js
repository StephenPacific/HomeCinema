import assert from "node:assert/strict";
import test from "node:test";
import {
  isLocalClientAddress,
  lanAddressCandidates,
  speakerJoinAddressCandidates
} from "../src/networkAddresses.js";

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

test("a VMware current URL cannot replace the recommended Windows WLAN join address", () => {
  const candidates = speakerJoinAddressCandidates({
    currentOrigin: "http://192.168.26.1:4173",
    loopback: false,
    advertised: [
      {
        url: "http://192.168.20.37:4173",
        interfaceName: "WLAN",
        virtual: false,
        recommended: true
      },
      {
        url: "http://192.168.26.1:4173",
        interfaceName: "VMware Network Adapter VMnet8",
        virtual: true,
        recommended: false
      }
    ]
  });

  assert.deepEqual(
    candidates.map(({ url, recommended, current }) => ({ url, recommended, current })),
    [
      { url: "http://192.168.20.37:4173", recommended: true, current: false },
      { url: "http://192.168.26.1:4173", recommended: false, current: true }
    ]
  );
});

test("loopback Controller pages exclude localhost from the Speaker QR list", () => {
  const candidates = speakerJoinAddressCandidates({
    currentOrigin: "http://127.0.0.1:4173",
    loopback: true,
    advertised: [
      { url: "http://192.168.20.37:4173", interfaceName: "WLAN", recommended: true }
    ]
  });

  assert.deepEqual(candidates.map((candidate) => candidate.url), ["http://192.168.20.37:4173"]);
});

test("same-machine loopback, WLAN, and VMware clients are recognized", () => {
  const interfaces = {
    "Wi-Fi": [ipv4("192.168.20.37")],
    "VMware Network Adapter VMnet8": [ipv4("192.168.26.1")]
  };

  assert.equal(isLocalClientAddress("::ffff:127.0.0.1", interfaces), true);
  assert.equal(isLocalClientAddress("192.168.20.37", interfaces), true);
  assert.equal(isLocalClientAddress("::ffff:192.168.26.1", interfaces), true);
  assert.equal(isLocalClientAddress("192.168.20.52", interfaces), false);
});
