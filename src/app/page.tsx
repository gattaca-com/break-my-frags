'use client'

import { useState, useEffect } from 'react';
import {
  JsonRpcProvider,
  Wallet,
  toBeHex,
  parseEther,
  parseUnits,
  formatEther,
  ZeroAddress
} from 'ethers';
import { HDNodeWallet } from 'ethers';
import { TransactionRequest } from 'ethers';

type TxInfo = {
  status: 'pending' | 'confirmed';
  sendTimeMs: number;
  blockNumber?: number;
  txIndex?: number;
  latencyMs?: number;
  nonce: number;
};

function calculateStats(txs: Record<string, TxInfo>) {
  const confirmedTxs = Object.values(txs)
    .filter(tx => tx.status === 'confirmed');

  const filteredTxs = confirmedTxs.sort((a, b) => b.sendTimeMs - a.sendTimeMs) // Sort by most recent first
    .slice(0, 50); // Take only last 50 transactions

  const latencies = filteredTxs.map(tx => tx.latencyMs || 0);

  const p50 = latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.5)] || 0;
  const avg = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0;

  return {
    totalTxs: Object.keys(txs).length,
    confirmedTxs: confirmedTxs.length,
    p50Latency: p50,
    avgLatency: avg,
  };
}

export default function Home() {
  const [provider, setProvider] = useState(() => new JsonRpcProvider(process.env.NEXT_PUBLIC_DEFAULT_RPC_URL));
  const [chainId, setChainId] = useState(BigInt(0));
  const [rpcUrl, setRpcUrl] = useState(process.env.NEXT_PUBLIC_DEFAULT_RPC_URL);
  const [wallet, setWallet] = useState<HDNodeWallet | null>(null);
  const [nonce, setNonce] = useState(0);
  const [txs, setTxs] = useState<Record<string, TxInfo>>({});
  const [pendingTxs, setPendingTxs] = useState<Set<string>>(new Set());
  const [balance, setBalance] = useState<bigint>(BigInt(0));
  const [pingLatency, setPingLatency] = useState<number>(0);
  const [autoSend, setAutoSend] = useState(false);

  const ethValue = parseUnits('1', 'gwei');
  const gasPrice = parseUnits('1', 'gwei');

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
      const updated = { ...txs };
      const stillPending = new Set<string>();

      for (const hash of pendingTxs) {
        const rcpt = await provider.getTransactionReceipt(hash);
        if (rcpt) {
          updated[hash] = {
            ...updated[hash],
            status: 'confirmed',
            blockNumber: rcpt.blockNumber,
            txIndex: rcpt.index,
            latencyMs: Date.now() - updated[hash].sendTimeMs,
          };
        } else {
          stillPending.add(hash);
        }
      }

      setTxs(updated);
      setPendingTxs(stillPending);
    }, 15);

    return () => clearInterval(interval);
  }, [pendingTxs, provider, txs]);

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
        console.error('Ping measurement failed:', error);
      }
    };

    measurePing();
    const interval = setInterval(measurePing, 500);
    return () => clearInterval(interval);
  }, [provider]);

  // Handler: airdrop funds and set up wallet
  const handleAirdrop = async () => {
    const w = Wallet.createRandom().connect(provider);
    setWallet(w);

    try {
      // Call the airdrop API
      const response = await fetch('/api/airdrop', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          address: w.address,
        }),
      });

      if (!response.ok) {
        throw new Error('Airdrop failed');
      }

      // Wait for the transaction to be mined
      const data = await response.json();
      await provider.waitForTransaction(data.txHash);

      // refresh the balance
      const bal = await provider.getBalance(w.address);
      setBalance(bal);

      // Get and set the nonce
      const currentNonce = await provider.getTransactionCount(w.address);
      console.log('Current nonce:', currentNonce);
      setNonce(currentNonce);
    } catch (error) {
      console.error('Airdrop failed:', error);
      setWallet(null); // Reset wallet on failure
    }
  };

  // Handler: send a transaction
  const handleSend = async () => {
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

    console.log('Sending transaction:', nonce);

    const signed = await wallet.signTransaction(tx);
    const sendTimeMs = Date.now();
    const response = await provider.broadcastTransaction(signed);

    setTxs((prev) => ({
      ...prev,
      [response.hash]: { status: 'pending', sendTimeMs, nonce },
    }));
    setPendingTxs((prev) => new Set([...prev, response.hash]));
  };

  // Add handler for RPC URL update
  const handleRpcUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    setProvider(new JsonRpcProvider(rpcUrl));
  };

  useEffect(() => {
    if (!autoSend || !wallet) return;

    const interval = setInterval(async () => {
      try {
        await handleSend();
      } catch (error) {
        console.error('Auto-send failed:', error);
        setAutoSend(false); // Stop auto-send on error
      }
    }, 25);

    return () => clearInterval(interval);
  }, [autoSend, wallet, handleSend]); // Added handleSend to dependencies

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
                    Your address: <span className="font-mono text-[#00FFB2]">{wallet.address}</span>
                  </p>
                  <p className="text-gray-300">
                    Balance: <span className="font-mono text-[#00FFB2]">{formatEther(balance)} ETH</span>
                  </p>
                </div>

                <div className="flex flex-col gap-2 items-end">
                  <button
                    onClick={handleSend}
                    className="bg-[#2A2A2E] hover:bg-[#3A3A3E] text-[#00FFB2] px-6 py-2 rounded-lg transition-colors duration-200 border border-[#00FFB2]"
                  >
                    Send TX
                  </button>
                  <div className="flex items-center gap-2">
                    <label className="text-sm text-gray-300">Auto Send</label>
                    <button
                      onClick={() => setAutoSend(!autoSend)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-200 ${autoSend ? 'bg-[#00FFB2]' : 'bg-[#2A2A2E]'
                        }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-200 ${autoSend ? 'translate-x-6' : 'translate-x-1'
                          }`}
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
                  <p className="text-2xl font-mono text-[#00FFB2]">{calculateStats(txs).totalTxs}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-gray-400">Confirmed TXs</p>
                  <p className="text-2xl font-mono text-[#00FFB2]">{calculateStats(txs).confirmedTxs}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-sm text-gray-400">Ping Latency</p>
                  <p className="text-2xl font-mono text-[#00FFB2]">{pingLatency}ms</p>
                </div>
                <div className="col-span-3">
                  <p className="text-sm text-gray-400 mb-2">Confirmation Latencies</p>
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-1">
                      <p className="text-sm text-gray-400">Median</p>
                      <p className="text-2xl font-mono text-[#00FFB2]">{calculateStats(txs).p50Latency}ms</p>
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm text-gray-400">Average</p>
                      <p className="text-2xl font-mono text-[#00FFB2]">{calculateStats(txs).avgLatency}ms</p>
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
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Tx Hash</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Status</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Block#</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Txn Idx</th>
                    <th className="px-4 py-2 text-left text-xs font-medium text-gray-400 uppercase tracking-wider">Latency (ms)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#2A2A2E]">
                  {Object.entries(txs)
                    .sort(([, a], [, b]) => b.sendTimeMs - a.sendTimeMs)
                    .slice(0, 50)
                    .map(([hash, info], index) => (
                      <tr key={hash} className={`hover:bg-[#1A1A1C] transition-colors duration-150 ${info.status === 'confirmed' ? 'bg-[#1A1A1C] confirm-flash' : ''
                        }`}>
                        <td className="px-4 py-2 font-mono text-sm text-gray-300">{info.nonce}</td>
                        <td className="px-4 py-2 font-mono text-sm text-[#00BFFF]">
                          <a
                            href={`${process.env.NEXT_PUBLIC_EXPLORER_URL}/tx/${hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:text-[#00FFB2] hover:underline"
                          >
                            {hash}
                          </a>
                        </td>
                        <td className="px-4 py-2 text-sm">
                          <span className={`inline-block px-3 py-1 rounded-lg text-xs font-medium ${info.status === 'confirmed'
                            ? 'bg-[#2A2A2E] text-[#00FFB2] border border-[#00FFB2]'
                            : 'bg-[#2A2A2E] text-[#FFB800] border border-[#FFB800]'
                            }`}>
                            {info.status}
                          </span>
                        </td>
                        <td className="px-4 py-2 font-mono text-sm text-gray-300">{info.blockNumber ?? '-'}</td>
                        <td className="px-4 py-2 font-mono text-sm text-gray-300">{info.txIndex ?? '-'}</td>
                        <td className="px-4 py-2 font-mono text-sm text-gray-300">{info.latencyMs ?? '-'}</td>
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
              <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
            </svg>
          </a>
        </div>
      </footer>
    </div>
  );
}
