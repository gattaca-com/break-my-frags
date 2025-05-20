import { NextResponse } from 'next/server';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';

if (!process.env.FUNDING_PRIVATE_KEY) {
    throw new Error('FUNDING_PRIVATE_KEY environment variable is not set');
}

export async function POST(request: Request) {
    try {
        const { address } = await request.json();
        console.log('Airdrop request received: ', address);

        if (!address) {
            return NextResponse.json(
                { error: 'Address is required' },
                { status: 400 }
            );
        }

        console.log('Connecting to RPC URL:', process.env.NEXT_PRIVATE_RPC_URL);

        const provider = new JsonRpcProvider(process.env.NEXT_PRIVATE_RPC_URL);

        // Test connection before proceeding
        try {
            const blockNumber = await provider.getBlockNumber();
            console.log('Connected to RPC, current block:', blockNumber);
        } catch (error) {
            console.error('Failed to connect to RPC:', error);
            return NextResponse.json(
                { error: 'Failed to connect to blockchain network' },
                { status: 500 }
            );
        }

        const fundingWallet = new Wallet(process.env.FUNDING_PRIVATE_KEY!, provider);
        const tx = await fundingWallet.sendTransaction({
            to: address,
            value: parseEther('0.01'),
        });

        console.log('Airdrop transaction sent: ', tx.hash);
        return NextResponse.json({ txHash: tx.hash });
    } catch (error) {
        console.error('Airdrop error:', error);
        return NextResponse.json(
            { error: `Airdrop failed: ${error instanceof Error ? error.message : 'Unknown error'}` },
            { status: 500 }
        );
    }
}
