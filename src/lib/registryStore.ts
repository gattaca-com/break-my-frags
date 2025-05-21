import { Gateway, FutureGateway } from '@/types';

type RegistryData = {
  lastUpdated: number;
  gateways: Gateway[];
  futureGateways: FutureGateway[];
}

class RegistryStore {
  private static instance: RegistryStore;
  private data: RegistryData = {
    lastUpdated: 0,
    gateways: [],
    futureGateways: []
  };
  private updateInterval: NodeJS.Timeout | null = null;
  private pingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private pingMeasurements: Map<string, number[]> = new Map();
  
  private constructor() {
    this.startPolling();
  }

  public static getInstance(): RegistryStore {
    if (!RegistryStore.instance) {
      RegistryStore.instance = new RegistryStore();
    }
    return RegistryStore.instance;
  }

  private async fetchRegisteredGateways(): Promise<Gateway[]> {
    const response = await fetch(process.env.NEXT_PUBLIC_REGISTRY_RPC_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "registry_registeredGateways",
        id: 1,
      }),
    });

    const data = await response.json();
    return data.result.map(([url, address]: [string, string]) => ({
      url,
      address,
    }));
  }

  private async fetchFutureGateway(blocks: number): Promise<FutureGateway> {
    const response = await fetch(process.env.NEXT_PUBLIC_REGISTRY_RPC_URL!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "registry_futureGateway",
        params: [blocks],
        id: 1,
      }),
    });

    const data = await response.json();
    const [blockNumber, url, address] = data.result;
    return { blockNumber, url, address };
  }

  private async measurePing(url: string): Promise<number> {
    const start = Date.now();
    try {
      await fetch(url);
      return Date.now() - start;
    } catch (error) {
      console.error(`Ping failed for ${url}:`, error);
      return -1;
    }
  }

  private updatePingStats(url: string, ping: number) {
    if (ping === -1) return;
    
    const measurements = this.pingMeasurements.get(url) || [];
    measurements.push(ping);
    
    // Keep only last 10 measurements
    if (measurements.length > 10) {
      measurements.shift();
    }
    
    this.pingMeasurements.set(url, measurements);
    
    // Update gateway ping in data
    this.data.gateways = this.data.gateways.map(gw => {
      if (gw.url === url) {
        const avg = Math.round(
          measurements.reduce((a, b) => a + b, 0) / measurements.length
        );
        return { ...gw, ping: avg };
      }
      return gw;
    });
  }

  private startPingMeasurement(url: string) {
    // Clear existing interval if any
    if (this.pingIntervals.has(url)) {
      clearInterval(this.pingIntervals.get(url)!);
    }

    // Start new interval
    const interval = setInterval(async () => {
      const ping = await this.measurePing(url);
      this.updatePingStats(url, ping);
    }, 1000);

    this.pingIntervals.set(url, interval);
  }

  private async updateData() {
    console.log("Updating registry data");
    try {
      const [registered, futureResults] = await Promise.all([
        this.fetchRegisteredGateways(),
        Promise.all(Array.from({ length: 60 }, (_, i) => this.fetchFutureGateway(i)))
      ]);

      futureResults.sort((a, b) => a.blockNumber - b.blockNumber);

      // Start ping measurements for new gateways
      registered.forEach(gateway => {
        if (!this.pingIntervals.has(gateway.url)) {
          this.startPingMeasurement(gateway.url);
        }
      });

      // Clean up ping measurements for removed gateways
      this.pingIntervals.forEach((_, url) => {
        if (!registered.find(gw => gw.url === url)) {
          clearInterval(this.pingIntervals.get(url)!);
          this.pingIntervals.delete(url);
          this.pingMeasurements.delete(url);
        }
      });

      this.data = {
        lastUpdated: Date.now(),
        gateways: registered,
        futureGateways: futureResults
      };
    } catch (error) {
      console.error('Failed to fetch registry data:', error);
    }
  }

  private startPolling() {
    this.updateData(); // Initial fetch
    this.updateInterval = setInterval(() => {
      this.updateData();
    }, 20000); // Poll every 20 seconds
  }

  public getData(): RegistryData {
    return this.data;
  }

  public cleanup() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    // Clean up all ping intervals
    this.pingIntervals.forEach(interval => clearInterval(interval));
    this.pingIntervals.clear();
    this.pingMeasurements.clear();
  }
}

export const registryStore = RegistryStore.getInstance(); 