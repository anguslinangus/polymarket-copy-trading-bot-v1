import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import { UserActivityInterface, UserPositionInterface } from '../interfaces/User';
import { getUserActivityModel } from '../models/userHistory';
import { ENV } from '../config/env';

const RETRY_LIMIT = ENV.RETRY_LIMIT;
const USER_ADDRESS = ENV.USER_ADDRESS;
const PRICE_DIFF_THRESHOLD = ENV.PRICE_DIFF_THRESHOLD;
const UserActivity = getUserActivityModel(USER_ADDRESS);

const postOrder = async (
    clobClient: ClobClient,
    condition: string,
    my_position: UserPositionInterface | undefined,
    user_position: UserPositionInterface | undefined,
    trade: UserActivityInterface,
    my_balance: number,
    user_balance: number
) => {
    //Merge strategy
    if (condition === 'merge') {
        console.log('Merging Strategy...');
        if (!my_position) {
            console.log('my_position is undefined');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }
        let remaining = my_position.size;
        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            // 修復 #10: 添加 API 錯誤處理
            let orderBook;
            try {
                orderBook = await clobClient.getOrderBook(trade.asset);
            } catch (error) {
                console.error('Failed to get order book:', error);
                retry += 1;
                continue;
            }

            if (!orderBook.bids || orderBook.bids.length === 0) {
                console.log('No bids found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max: any, bid: any) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            console.log('Max price bid:', maxPriceBid);
            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: my_position.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            console.log('Order args:', order_arges);
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                console.log('Successfully posted order:', resp);
                remaining -= order_arges.amount;
            } else {
                retry += 1;
                console.log('Error posting order: retrying...', resp);
            }
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else if (condition === 'buy') {       //Buy strategy
        console.log('Buy Strategy...');

        // 修復 #17: 防止除以零
        const denominator = user_balance + trade.usdcSize;
        if (denominator === 0) {
            console.log('Invalid balance calculation (denominator is 0)');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        const ratio = my_balance / denominator;
        console.log('ratio', ratio);
        let remaining = trade.usdcSize * ratio;

        // 修復 #11: 檢查餘額是否足夠
        if (my_balance < remaining) {
            console.log(`Insufficient balance: have ${my_balance} USDC, need ${remaining} USDC`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            // 修復 #10: 添加 API 錯誤處理
            let orderBook;
            try {
                orderBook = await clobClient.getOrderBook(trade.asset);
            } catch (error) {
                console.error('Failed to get order book:', error);
                retry += 1;
                continue;
            }

            if (!orderBook.asks || orderBook.asks.length === 0) {
                console.log('No asks found');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }

            const minPriceAsk = orderBook.asks.reduce((min: any, ask: any) => {
                return parseFloat(ask.price) < parseFloat(min.price) ? ask : min;
            }, orderBook.asks[0]);

            console.log('Min price ask:', minPriceAsk);
            // 修復 #6: 使用環境變數代替硬編碼閾值
            if (parseFloat(minPriceAsk.price) - PRICE_DIFF_THRESHOLD > trade.price) {
                console.log(`Price difference too large (threshold: ${PRICE_DIFF_THRESHOLD}) - do not copy`);
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                break;
            }
            let order_arges;
            if (remaining <= parseFloat(minPriceAsk.size) * parseFloat(minPriceAsk.price)) {
                order_arges = {
                    side: Side.BUY,
                    tokenID: trade.asset,
                    amount: remaining,
                    price: parseFloat(minPriceAsk.price),
                };
            } else {
                order_arges = {
                    side: Side.BUY,
                    tokenID: trade.asset,
                    amount: parseFloat(minPriceAsk.size) * parseFloat(minPriceAsk.price),
                    price: parseFloat(minPriceAsk.price),
                };
            }
            console.log('Order args:', order_arges);
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                console.log('Successfully posted order:', resp);
                remaining -= order_arges.amount;
            } else {
                retry += 1;
                console.log('Error posting order: retrying...', resp);
            }
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else if (condition === 'sell') {          //Sell strategy
        console.log('Sell Strategy...');
        if (!my_position) {
            console.log('No position to sell');
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;  // 修復 #4: 添加 return 避免執行無效循環
        }

        let remaining = 0;
        if (!user_position) {
            remaining = my_position.size;
        } else {
            // 修復 #17: 防止除以零
            const denominator = user_position.size + trade.size;
            if (denominator === 0) {
                console.log('Invalid position calculation (denominator is 0)');
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                return;
            }
            const ratio = trade.size / denominator;
            console.log('ratio', ratio);
            remaining = my_position.size * ratio;
        }

        // 修復 #12: 檢查倉位是否足夠
        if (my_position.size < remaining) {
            console.log(`Insufficient position: have ${my_position.size}, need to sell ${remaining}`);
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
            return;
        }

        let retry = 0;
        while (remaining > 0 && retry < RETRY_LIMIT) {
            // 修復 #10: 添加 API 錯誤處理
            let orderBook;
            try {
                orderBook = await clobClient.getOrderBook(trade.asset);
            } catch (error) {
                console.error('Failed to get order book:', error);
                retry += 1;
                continue;
            }

            if (!orderBook.bids || orderBook.bids.length === 0) {
                await UserActivity.updateOne({ _id: trade._id }, { bot: true });
                console.log('No bids found');
                break;
            }

            const maxPriceBid = orderBook.bids.reduce((max: any, bid: any) => {
                return parseFloat(bid.price) > parseFloat(max.price) ? bid : max;
            }, orderBook.bids[0]);

            console.log('Max price bid:', maxPriceBid);
            let order_arges;
            if (remaining <= parseFloat(maxPriceBid.size)) {
                order_arges = {
                    side: Side.SELL,
                    tokenID: trade.asset,
                    amount: remaining,
                    price: parseFloat(maxPriceBid.price),
                };
            } else {
                order_arges = {
                    side: Side.SELL,
                    tokenID: trade.asset,
                    amount: parseFloat(maxPriceBid.size),
                    price: parseFloat(maxPriceBid.price),
                };
            }
            console.log('Order args:', order_arges);
            const signedOrder = await clobClient.createMarketOrder(order_arges);
            const resp = await clobClient.postOrder(signedOrder, OrderType.FOK);
            if (resp.success === true) {
                retry = 0;
                console.log('Successfully posted order:', resp);
                remaining -= order_arges.amount;
            } else {
                retry += 1;
                console.log('Error posting order: retrying...', resp);
            }
        }
        if (retry >= RETRY_LIMIT) {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true, botExcutedTime: retry });
        } else {
            await UserActivity.updateOne({ _id: trade._id }, { bot: true });
        }
    } else {
        console.log('Condition not supported');
    }
};

export default postOrder;
