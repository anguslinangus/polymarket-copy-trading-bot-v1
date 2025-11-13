import connectDB from './config/db';
import { ENV } from './config/env';
import createClobClient from './services/createClobClient';
import tradeExecutor from './services/tradeExecutor';
import tradeMonitor from './services/tradeMonitor';
import test from './test/test';

const USER_ADDRESS = ENV.USER_ADDRESS;
const PROXY_WALLET = ENV.PROXY_WALLET;

export const main = async () => {
    await connectDB();
    console.log(`Target User Wallet address is: ${USER_ADDRESS}`);
    console.log(`My Wallet address is: ${PROXY_WALLET}`);
    const clobClient = await createClobClient();

    // 使用 Promise.all 並行運行兩個監控循環，並添加錯誤處理
    await Promise.all([
        tradeMonitor().catch((err) => {
            console.error('❌ Trade Monitor crashed:', err);
            process.exit(1);
        }),
        tradeExecutor(clobClient).catch((err) => {
            console.error('❌ Trade Executor crashed:', err);
            process.exit(1);
        }),
    ]);
};

// 優雅關閉處理
process.on('SIGINT', () => {
    console.log('\n⚠️  Received SIGINT, shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n⚠️  Received SIGTERM, shutting down gracefully...');
    process.exit(0);
});

main().catch((err) => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
