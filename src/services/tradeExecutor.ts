import { ClobClient } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { ENV } from '../config/env';
import { getUserActivityModel } from '../models/userHistory';
import fetchData from '../utils/fetchData';
import spinner from '../utils/spinner';
import getMyBalance from '../utils/getMyBalance';
import postOrder from '../utils/postOrder';

const USER_ADDRESS = ENV.USER_ADDRESS;
const RETRY_LIMIT = ENV.RETRY_LIMIT;
const PROXY_WALLET = ENV.PROXY_WALLET;

let temp_trades: UserActivityInterface[] = [];

const UserActivity = getUserActivityModel(USER_ADDRESS);

const readTempTrade = async () => {
    temp_trades = (
        await UserActivity.find({
            $and: [{ type: 'TRADE' }, { bot: false }, { botExcutedTime: { $lt: RETRY_LIMIT } }],
        }).exec()
    ).map((trade: any) => trade as UserActivityInterface);
};

const doTrading = async (clobClient: ClobClient) => {
    for (const trade of temp_trades) {
        console.log('📋 Trade to copy:', trade.side, trade.size, '@', trade.price, '-', trade.title);

        try {
            // 獲取持倉資訊
            const my_positions: UserPositionInterface[] = await fetchData(
                `https://data-api.polymarket.com/positions?user=${PROXY_WALLET}`
            );
            const user_positions: UserPositionInterface[] = await fetchData(
                `https://data-api.polymarket.com/positions?user=${USER_ADDRESS}`
            );

            // 修復 #8: 同時匹配 conditionId 和 asset 以避免找到錯誤的倉位
            const my_position = my_positions.find(
                (position: UserPositionInterface) =>
                    position.conditionId === trade.conditionId &&
                    position.asset === trade.asset
            );
            const user_position = user_positions.find(
                (position: UserPositionInterface) =>
                    position.conditionId === trade.conditionId &&
                    position.asset === trade.asset
            );

            // 獲取餘額
            const my_balance = await getMyBalance(PROXY_WALLET);
            const user_balance = await getMyBalance(USER_ADDRESS);

            console.log('💰 My balance:', my_balance, 'USDC | User balance:', user_balance, 'USDC');
            console.log('📊 My position:', my_position?.size || 0, '| User position:', user_position?.size || 0);

            // 判斷交易策略
            let condition: string;

            if (trade.side === 'BUY') {
                // 目標用戶買入，我也買入
                condition = 'buy';
                console.log('🟢 Strategy: BUY');
            } else if (trade.side === 'SELL') {
                // 目標用戶賣出
                if (!user_position || user_position.size === 0) {
                    // 目標用戶已完全平倉，我也應該平倉
                    if (my_position && my_position.size > 0) {
                        condition = 'merge';
                        console.log('🔴 Strategy: MERGE (user closed position)');
                    } else {
                        // 我沒有持倉，無需操作
                        console.log('⏭️  Skip: No position to close');
                        await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                        continue;
                    }
                } else {
                    // 目標用戶部分賣出，我也按比例賣出
                    condition = 'sell';
                    console.log('🔴 Strategy: SELL');
                }
            } else {
                console.log('⚠️  Unknown trade side:', trade.side);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                continue;
            }

            // 執行交易
            await postOrder(
                clobClient,
                condition,
                my_position,
                user_position,
                trade,
                my_balance,
                user_balance
            );

        } catch (error) {
            console.error('❌ Error processing trade:', error);
            // 增加重試計數
            await UserActivity.updateOne(
                { _id: trade._id },
                { $inc: { botExcutedTime: 1 } }
            );
        }
    }
};

const tradeExcutor = async (clobClient: ClobClient) => {
    console.log(`Executing Copy Trading`);

    while (true) {
        await readTempTrade();
        if (temp_trades.length > 0) {
            console.log('💥 New transactions found 💥');
            spinner.stop();
            await doTrading(clobClient);
        } else {
            spinner.start('Waiting for new transactions');
        }
    }
};

export default tradeExcutor;
