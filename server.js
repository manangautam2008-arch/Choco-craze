
require("dotenv").config();

const express = require("express");
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = process.env.PORT || 3000;

// Format amount in Indian currency
function money(amount) {
    return "₹" + Number(amount).toLocaleString("en-IN");
}

// Clean text before adding it to Telegram message
function cleanText(value) {
    return String(value || "None").slice(0, 1000);
}

// Calculate coupon discount on the server
function calculateDiscount(subtotal, coupon) {
    if (coupon === "SWEET10" && subtotal >= 299) {
        return Math.min(Math.round(subtotal * 0.10), 150);
    }

    if (coupon === "CRAZE50" && subtotal >= 499) {
        return 50;
    }

    return 0;
}

// Format custom dessert box details
function formatItemDetails(item) {
    if (!item.details) return "";

    const details = String(item.details);

    const packagingMatch = details.match(/\+\s*₹99\s*gift packaging/i);

    const treats = details
        .replace(/\+\s*₹99\s*gift packaging/i, "")
        .split(",")
        .map(name => name.trim())
        .filter(Boolean);

    let output = "\n";

    treats.forEach((treat, index) => {
        const prefix = index === treats.length - 1 && !packagingMatch
            ? "  └ "
            : "  ├ ";

        output += `${prefix}${cleanText(treat)}\n`;
    });

    if (packagingMatch) {
        output += "  └ Gift packaging: ₹99\n";
    }

    return output;
}

// Send message to Telegram
async function sendTelegramMessage(message) {
    if (!BOT_TOKEN || !CHAT_ID) {
        throw new Error("Telegram configuration is missing in .env");
    }

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            chat_id: CHAT_ID,
            text: message
        })
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
        throw new Error(result.description || "Telegram message failed");
    }

    return result;
}

// Receive orders from website
app.post("/api/order", async (req, res) => {
    try {
        const order = req.body;

        // Basic order validation
        if (
            !order ||
            !order.name ||
            !order.phone ||
            !order.address ||
            !Array.isArray(order.items) ||
            order.items.length === 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Please provide complete order details."
            });
        }

        // Calculate item totals
        let subtotal = 0;

        const itemMessages = order.items.map(item => {
            const price = Number(item.price);
            const quantity = Number(item.quantity);

            if (
                !item.name ||
                !Number.isFinite(price) ||
                !Number.isInteger(quantity) ||
                price < 0 ||
                quantity < 1 ||
                quantity > 100
            ) {
                throw new Error("Invalid order item.");
            }

            const itemTotal = price * quantity;
            subtotal += itemTotal;

            let itemMessage =
                `• ${cleanText(item.name)} x ${quantity}\n` +
                `  ${money(price)} × ${quantity} = ${money(itemTotal)}\n`;

            // Add custom dessert box contents
            if (item.details) {
                itemMessage += formatItemDetails(item);
            }

            return itemMessage;
        });

        // Calculate discount using valid coupon codes
        const coupon = String(order.coupon || "").trim().toUpperCase();
        const discount = calculateDiscount(subtotal, coupon);
        const total = subtotal - discount;

        // Coupon display
        let couponMessage = "None";

        if (coupon) {
            couponMessage = discount > 0
                ? `${coupon} (Applied)`
                : `${coupon} (Not applied)`;
        }

        // Build complete Telegram message
        const message = `
🍫 NEW CHOCO CRAZE ORDER!

🆔 Order ID: ${cleanText(order.orderId)}

👤 CUSTOMER DETAILS
Name: ${cleanText(order.name)}
Phone: ${cleanText(order.phone)}
Address: ${cleanText(order.address)}

🛒 ORDER ITEMS

${itemMessages.join("\n")}

━━━━━━━━━━━━━━━━
🧾 ORDER BILL

Subtotal: ${money(subtotal)}
Coupon: ${couponMessage}
Discount: -${money(discount)}

━━━━━━━━━━━━━━━━
💰 FINAL BILL: ${money(total)}

💳 Payment Method: ${cleanText(order.payment)}
📝 Order Note: ${cleanText(order.note)}
━━━━━━━━━━━━━━━━

Thank you for choosing Choco Craze! 🍫
`;

        // Send order notification
        await sendTelegramMessage(message);

        res.json({
            success: true,
            message: "Order sent to Telegram!",
            subtotal,
            discount,
            total
        });

    } catch (error) {
        console.error("Order error:", error.message);

        res.status(500).json({
            success: false,
            message: "Failed to send order notification."
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Choco Craze server running at http://localhost:${PORT}`);
});
