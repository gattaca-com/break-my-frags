"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { JsonRpcProvider, Wallet, parseUnits, formatEther } from "ethers";
import { HDNodeWallet } from "ethers";
import { TransactionRequest } from "ethers";
import { FutureGateway, Gateway } from "@/types";

type TxInfo = {
  hash: string;
  sendTimeMs: number;
  blockNumber?: number;
  latencyMs?: number;
};

function calculateStats(
  confirmedTxs: Map<number, TxInfo>,
  stillPending: number
) {
  const filteredTxs = Array.from(confirmedTxs.entries())
    .sort(([nonceA], [nonceB]) => Number(nonceB) - Number(nonceA))
    .slice(0, 50) // Take only last 50 transactions
    .map(([, tx]) => tx);

  const latencies = filteredTxs
    .map((tx) => tx.latencyMs || 0)
    .filter((latency) => latency > 0); // Only include confirmed transactions

  const p50 =
    latencies.length > 0
      ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)]
      : 0;

  const avg =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;

  return {
    totalTxs: confirmedTxs.size + stillPending,
    confirmedTxs: confirmedTxs.size,
    p50Latency: p50,
    avgLatency: avg,
  };
}

export default function Home() {
  const [provider, setProvider] = useState(
    () => new JsonRpcProvider(process.env.NEXT_PUBLIC_DEFAULT_RPC_URL)
  );
  const [chainId, setChainId] = useState(BigInt(0));
  const [currentBlock, setCurrentBlock] = useState<number>(0);
  const [rpcUrl, setRpcUrl] = useState(process.env.NEXT_PUBLIC_DEFAULT_RPC_URL);
  const [wallet, setWallet] = useState<HDNodeWallet | null>(null);
  const [nonce, setNonce] = useState(0);
  const [confirmedTxs, setConfirmedTxs] = useState<Map<number, TxInfo>>(
    new Map()
  );
  const [pendingTxs, setPendingTxs] = useState<Map<number, TxInfo>>(new Map());
  const [balance, setBalance] = useState<bigint>(BigInt(0));
  const [pingLatency, setPingLatency] = useState<number>(0);
  const [autoSend, setAutoSend] = useState(false);
  const isPolling = useRef(false);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [futureGateways, setFutureGateways] = useState<FutureGateway[]>([]);

  const ethValue = parseUnits("1", "gwei");
  const gasPrice = parseUnits("0.1", "gwei");

  // Initialize provider and chain ID on mount
  useEffect(() => {
    const initProvider = async () => {
      const network = await provider.getNetwork();
      setChainId(network.chainId);
    };
    initProvider();
  }, [provider]);

  // Poll for specific transaction receipts
  useEffect(() => {
    if (pendingTxs.size === 0) return;

    const interval = setInterval(async () => {
      if (isPolling.current) return;
      isPolling.current = true;

      try {
        const stillPending: Map<number, TxInfo> = new Map();
        const updated: Map<number, TxInfo> = new Map();

        for (const [nonce, info] of pendingTxs.entries()) {
          const rcpt = await provider.getTransactionReceipt(info.hash);
          if (rcpt) {
            updated.set(nonce, {
              ...info,
              blockNumber: rcpt.blockNumber,
              latencyMs: Date.now() - info.sendTimeMs,
            });
          } else {
            stillPending.set(nonce, info);
          }
        }

        setConfirmedTxs((prev) => {
          // Combine previous and new transactions
          const allTxs = new Map([...prev, ...updated]);

          // Sort by nonce (descending) and take only the first 100
          const sortedEntries = Array.from(allTxs.entries())
            .sort(([nonceA], [nonceB]) => nonceB - nonceA)
            .slice(0, 100);

          // Create new Map with only the latest 100 transactions
          return new Map(sortedEntries);
        });

        setPendingTxs((prev) => {
          const next = new Map(prev);
          for (const nonce of updated.keys()) {
            next.delete(nonce);
          }
          return next;
        });
      } finally {
        isPolling.current = false;
      }
    }, 20);

    return () => clearInterval(interval);
  }, [pendingTxs, provider]);

  // Add this effect to update balance
  useEffect(() => {
    if (!wallet) return;

    const updateBalance = async () => {
      const bal = await provider.getBalance(wallet.address);
      setBalance(bal);
    };

    updateBalance();
    const interval = setInterval(updateBalance, 1000); // Update every second

    return () => clearInterval(interval);
  }, [wallet, provider]);

  // Add this effect for ping measurement
  useEffect(() => {
    const measurePing = async () => {
      const start = Date.now();
      try {
        await provider.getNetwork();
        const end = Date.now();
        setPingLatency(end - start);
      } catch (error) {
        console.error("Ping measurement failed:", error);
      }
    };

    measurePing();
    const interval = setInterval(measurePing, 500);
    return () => clearInterval(interval);
  }, [provider]);

  // Add this effect for block number updates
  useEffect(() => {
    const updateBlockNumber = async () => {
      try {
        const blockNumber = await provider.getBlockNumber();
        setCurrentBlock(blockNumber);
      } catch (error) {
        console.error("Failed to fetch block number:", error);
      }
    };

    updateBlockNumber();
    const interval = setInterval(updateBlockNumber, 1000);
    return () => clearInterval(interval);
  }, [provider]);

  // Handler: airdrop funds and set up wallet
  const handleAirdrop = async () => {
    const w = Wallet.createRandom().connect(provider);
    setWallet(w);

    try {
      // Call the airdrop API
      const response = await fetch("/api/airdrop", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          address: w.address,
        }),
      });

      if (!response.ok) {
        throw new Error("Airdrop failed");
      }

      // Wait for the transaction to be mined
      const data = await response.json();
      await provider.waitForTransaction(data.txHash);

      // refresh the balance
      const bal = await provider.getBalance(w.address);
      setBalance(bal);

      // Get and set the nonce
      const currentNonce = await provider.getTransactionCount(w.address);
      console.log("Current nonce:", currentNonce);
      setNonce(currentNonce);
    } catch (error) {
      console.error("Airdrop failed:", error);
      setWallet(null); // Reset wallet on failure
    }
  };

  // Wrap handleSend in useCallback
  const handleSend = useCallback(async () => {
    if (!wallet) return;
    const tx: TransactionRequest = {
      chainId,
      nonce,
      gasLimit: 21_000,
      to: wallet.address,
      value: ethValue,
      gasPrice,
    };
    setNonce((n) => n + 1);

    console.log("Sending transaction:", nonce);

    const signed = await wallet.signTransaction(tx);
    const sendTimeMs = Date.now();
    const response = await provider.broadcastTransaction(signed);

    setPendingTxs((prev) => {
      const next = new Map(prev);
      next.set(nonce, {
        hash: response.hash,
        sendTimeMs,
      });
      return next;
    });
  }, [wallet, chainId, nonce, ethValue, gasPrice, provider]);

  // Add handler for RPC URL update
  const handleRpcUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setProvider(new JsonRpcProvider(rpcUrl));
    console.log("RPC URL updated to:", rpcUrl);
  };

  useEffect(() => {
    if (!autoSend || !wallet) return;

    const interval = setInterval(async () => {
      try {
        await handleSend();
      } catch (error) {
        console.error("Auto-send failed:", error);
        setAutoSend(false);
      }
    }, 150);

    return () => clearInterval(interval);
  }, [autoSend, wallet, handleSend]); // Added handleSend to dependencies

  useEffect(() => {
    const fetchGateways = async () => {
      try {
        const response = await fetch("/api/registry");
        const data = await response.json();

        setGateways(data.gateways);
        setFutureGateways(data.futureGateways);
      } catch (error) {
        console.error("Failed to fetch gateways:", error);
      }
    };

    fetchGateways();
    const interval = setInterval(fetchGateways, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="min-h-screen bg-[#0A0A0C] p-8 font-sans text-gray-100 flex flex-col">
      <div className="max-w-6xl mx-auto flex-grow w-full">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-4xl font-bold bg-gradient-to-r from-[#00FFB2] to-[#00BFFF] bg-clip-text text-transparent">
            Break my frags
          </h1>

          <form onSubmit={handleRpcUpdate} className="flex gap-2">
            <input
              type="text"
              value={rpcUrl}
              onChange={(e) => setRpcUrl(e.target.value)}
              className="bg-[#161618] border border-[#2A2A2E] px-4 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#00FFB2] focus:border-transparent text-gray-100 placeholder-gray-500"
              placeholder="RPC URL"
            />
            <button
              type="submit"
              className="bg-[#2A2A2E] hover:bg-[#3A3A3E] text-[#00FFB2] px-6 py-2 rounded-lg transition-colors duration-200 border border-[#00FFB2]"
            >
              Update RPC
            </button>
          </form>
        </div>

        <div className="bg-[#161618] rounded-xl overflow-hidden border border-[#2A2A2E] mb-6">
          <table className="w-full">
            <thead className="bg-[#1A1A1C] border-b border-[#2A2A2E]">
              <tr>
                <th className="text-left p-4 text-sm text-gray-400 font-medium">
                  Gateway
                </th>
                <th className="text-left p-4 text-sm text-gray-400 font-medium">
                  Address
                </th>
                <th className="text-left p-4 text-sm text-gray-400 font-medium">
                  Role
                </th>
                <th className="text-left p-4 text-sm text-gray-400 font-medium">
                  Ping (sequencer)
                </th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const currentUrl = futureGateways.find(
                  (gw) => gw.blockNumber === currentBlock
                )?.url;

                const nextUrl = futureGateways.find(
                  (gw) => gw.blockNumber > currentBlock && gw.url !== currentUrl
                )?.url;

                const blocksLeft = futureGateways.filter(
                  (gw) =>
                    gw.url === currentUrl && gw.blockNumber >= currentBlock
                ).length;

                return gateways.map((gateway, i) => {
                  const isCurrent = currentUrl === gateway.url;
                  const isNext = nextUrl === gateway.url;

                  return (
                    <tr
                      key={i}
                      className={`border-b border-[#2A2A2E] ${
                        isCurrent ? "bg-[#2A2A2E]" : ""
                      }`}
                    >
                      <td className="p-4">
                        <p className="font-mono text-[#00FFB2]">
                          {gateway.url}
                        </p>
                      </td>
                      <td className="p-4">
                        <p className="font-mono text-[#00FFB2]">
                          {gateway.address}
                        </p>
                      </td>
                      <td className="p-4">
                        {isCurrent && (
                          <span className="px-3 py-1.5 rounded-lg text-sm bg-[#00FFB2] text-[#0A0A0C] whitespace-nowrap">
                            Leader ({blocksLeft} blocks)
                          </span>
                        )}
                        {isNext && (
                          <span className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#2A2A2E] text-[#7F5FFF] border border-[#7F5FFF]">
                            Next
                          </span>
                        )}
                        {!isCurrent && !isNext && (
                          <span className="text-gray-400">Standby</span>
                        )}
                      </td>
                      <td className="p-4">
                        <span
                          className={
                            gateway.ping
                              ? "font-mono text-[#00FFB2]"
                              : "text-gray-400"
                          }
                        >
                          {gateway.ping ? `${gateway.ping}ms` : "-"}
                        </span>
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
        </div>

        {!wallet ? (
          <div className="flex justify-center items-center min-h-[200px]">
            <button
              onClick={handleAirdrop}
              className="bg-[#00FFB2] hover:bg-[#00E6A1] text-[#0A0A0C] px-8 py-3 rounded-lg transition-colors duration-200 text-lg font-medium"
            >
              Airdrop ETH
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="bg-[#161618] p-6 rounded-xl border border-[#2A2A2E]">
              <div className="flex justify-between items-start">
                <div className="space-y-2">
                  <p className="text-gray-300">
                    Your address:{" "}
                    <span className="font-mono text-[#00FFB2]">
                      {wallet.address}
                    </span>
                  </p>
                  <p className="text-gray-300">
                    Balance:{" "}
                    <span className="font-mono text-[#00FFB2]">
                      {balance === BigInt(0)
                        ? "Waiting for airdrop..."
                        : `${formatEther(balance)} ETH`}
                    </span>
                  </p>
                </div>

                <div className="flex flex-col gap-2 items-end">
                  <button
                    onClick={handleSend}
                    disabled={balance === BigInt(0)}
                    className={`px-6 py-2 rounded-lg transition-colors duration-200 border ${
                      balance === BigInt(0)
                        ? "bg-[#1A1A1C] text-gray-500 border-gray-500 cursor-not-allowed"
                        : "bg-[#2A2A2E] hover:bg-[#3A3A3E] text-[#00FFB2] border-[#00FFB2]"
                    }`}
                  >
                    Send TX
                  </button>
                  <div className="flex items-center gap-2">
                    <label
                      className={`text-sm ${
                        balance === BigInt(0)
                          ? "text-gray-500"
                          : "text-gray-300"
                      }`}
                    >
                      Auto Send
                    </label>
                    <button
                      onClick={() =>
                        balance > BigInt(0) && setAutoSend(!autoSend)
                      }
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${
                        balance === BigInt(0)
                          ? "bg-[#1A1A1C] cursor-not-allowed"
                          : autoSend
                          ? "bg-[#00FFB2]"
                          : "bg-[#2A2A2E]"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full transition-transform duration-200 ${
                          autoSend
                            ? "translate-x-6 bg-white"
                            : "translate-x-1 bg-gray-400"
                        } ${balance === BigInt(0) ? "bg-gray-600" : ""}`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#161618] p-6 rounded-xl border border-[#2A2A2E] mb-6">
              <div className="grid grid-cols-6 gap-4">
                <div className="space-y-1">
                  <p className="text-sm text-gray-400">Total TXs</p>
                  <p className="text-2xl font-mono text-[#00FFB2]">
                    {calculateStats(confirmedTxs, pendingTxs.size).totalTxs}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-gray-400">Confirmed TXs</p>
                  <p className="text-2xl font-mono text-[#00FFB2]">
                    {calculateStats(confirmedTxs, pendingTxs.size).confirmedTxs}
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-gray-400">Ping Latency (RPC)</p>
                  <p className="text-2xl font-mono text-[#00FFB2]">
                    {pingLatency}ms
                  </p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-gray-400">Current Block</p>
                  <p className="text-2xl font-mono text-[#00FFB2]">
                    {currentBlock}
                  </p>
                </div>
                <div className="col-span-2">
                  <p className="text-sm text-gray-400 mb-2">
                    Confirmation Latencies
                  </p>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <p className="text-sm text-gray-400">Median</p>
                      <p className="text-2xl font-mono text-[#00FFB2]">
                        {
                          calculateStats(confirmedTxs, pendingTxs.size)
                            .p50Latency
                        }
                        ms
                      </p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm text-gray-400">Average</p>
                      <p className="text-2xl font-mono text-[#00FFB2]">
                        {
                          calculateStats(confirmedTxs, pendingTxs.size)
                            .avgLatency
                        }
                        ms
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-[#161618] rounded-xl overflow-hidden border border-[#2A2A2E]">
              <table className="w-full">
                <thead className="bg-[#1A1A1C]">
                  <tr>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider"></th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Tx Hash
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Block #
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Latency
                    </th>
                    {/* <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Gateway
                    </th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">
                      Network
                    </th> */}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2A2A2E]">
                  {[...confirmedTxs.entries(), ...pendingTxs.entries()]
                    .sort(([nonceA], [nonceB]) => nonceB - nonceA)
                    .slice(0, 50)
                    .map(([nonce, info]) => (
                      <tr
                        key={nonce}
                        className="hover:bg-[#1A1A1C] transition-colors duration-150"
                      >
                        <td className="px-4 py-2 font-mono text-sm text-gray-300">
                          {nonce}
                        </td>
                        <td className="px-4 py-2 font-mono text-sm text-[#00BFFF]">
                          <a
                            href={`${process.env.NEXT_PUBLIC_EXPLORER_URL}/tx/${info.hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-[#00FFB2] hover:underline"
                          >
                            {info.hash.slice(0, 10)}...
                          </a>
                        </td>
                        <td className="px-4 py-2 text-sm">
                          <span
                            className={`inline-block px-3 py-1 rounded-lg text-xs font-medium transition-all duration-300 ${
                              info.blockNumber
                                ? "bg-[#2A2A2E] text-[#00FFB2] border border-[#00FFB2]"
                                : "bg-[#2A2A2E] text-[#FFB800] border border-[#FFB800]"
                            }`}
                          >
                            {info.blockNumber ? "confirmed" : "pending"}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-sm text-gray-300">
                          {info.blockNumber ?? "-"}
                        </td>
                        <td className="px-4 py-2 font-mono text-sm text-gray-300">
                          {info.latencyMs ? info.latencyMs + "ms" : "-"}
                        </td>
                        {/* <td className="px-4 py-2 font-mono text-sm text-gray-300">
                          -
                        </td>
                        <td className="px-4 py-2 font-mono text-sm text-gray-300">
                          -
                        </td> */}
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <footer className="max-w-6xl mx-auto mt-8 pt-8 border-t border-gray-800">
        <div className="flex justify-center space-x-6">
          <a
            href="https://x.com/gattacahq"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-blue-400 transition-colors duration-200"
          >
            <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
          <a
            href="https://github.com/gattaca-com/based-op"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-blue-400 transition-colors duration-200"
          >
            <svg className="h-6 w-6" fill="currentColor" viewBox="0 0 24 24">
              <path
                fillRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                clipRule="evenodd"
              />
            </svg>
          </a>
        </div>
      </footer>
    </div>
  );
}
