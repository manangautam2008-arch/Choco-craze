
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { rateLimit } = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 3000;

// --------------------------------------------------
// BASIC SERVER CONFIGURATION
// --------------------------------------------------

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));

// --------------------------------------------------
// SUPABASE CONNECTION
// --------------------------------------------------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = SUPABASE_URL && SUPABASE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_KEY)
    : null;

// --------------------------------------------------
// ADMIN SECURITY
// --------------------------------------------------

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET;

const COOKIE_NAME = "chococraze_admin";
const SESSION_DURATION = 8 * 60 * 60 * 1000;

const secureCookie =
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.RENDER);

const cookieOptions = {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "strict",
    path: "/"
};

// --------------------------------------------------
// PRODUCT CATALOGUE
// --------------------------------------------------

const PRODUCTS = {
    "Chocolate Truffle": 249,
    "Belgian Chocolate Cake": 699,
    "Strawberry Ice Cream": 149,
    "Chocolate Brownie": 129,
    "Red Velvet Cake": 599,
    "Chocolate Ice Cream": 179,
    "Chocolate Cupcakes": 299,
    "Chocolate Sundae": 219
};

const ORDER_STATUSES = [
    "Order Placed",
    "Confirmed",
    "Preparing",
    "Out for Delivery",
    "Delivered",
    "Cancelled"
];

// --------------------------------------------------
// HELPER FUNCTIONS
// --------------------------------------------------

function money(amount) {
    return "₹" + Number(amount).toLocaleString("en-IN");
}

function cleanText(value, maxLength = 1000) {
    return String(value || "None").slice(0, maxLength);
}

function calculateDiscount(subtotal, coupon) {
    if (coupon === "SWEET10" && subtotal >= 299) {
        return Math.min(Math.round(subtotal * 0.10), 150);
    }

    if (coupon === "CRAZE50" && subtotal >= 499) {
        return 50;
    }

    return 0;
}

function requireDatabase(res) {
    if (!supabase) {
        res.status(503).json({
            success: false,
            message: "Database configuration is missing."
        });

        return false;
    }

    return true;
}

// --------------------------------------------------
// VALIDATE ITEMS & CALCULATE SERVER-SIDE PRICES
// --------------------------------------------------

function validateItems(items) {
    if (
        !Array.isArray(items) ||
        items.length === 0 ||
        items.length > 50
    ) {
        throw new Error("Invalid order items.");
    }

    let subtotal = 0;

    const verifiedItems = items.map(item => {
        if (!item || typeof item !== "object") {
            throw new Error("Invalid order item.");
        }

        const quantity = Number(item.quantity);

        if (
            !Number.isInteger(quantity) ||
            quantity < 1 ||
            quantity > 100
        ) {
            throw new Error("Invalid item quantity.");
        }

        let price;
        let details = "";

        // Custom dessert box
        if (
            item.name === "Custom Dessert Box" ||
            item.custom === true
        ) {
            const rawDetails = String(item.details || "");

            const treats = rawDetails
                .replace(/\+\s*₹99\s*gift packaging/i, "")
                .split(",")
                .map(name => name.trim())
                .filter(Boolean);

            if (
                treats.length < 2 ||
                treats.length > 20
            ) {
                throw new Error(
                    "A custom dessert box must contain at least two treats."
                );
            }

            const treatsTotal = treats.reduce((sum, name) => {
                if (
                    !Object.prototype.hasOwnProperty.call(PRODUCTS, name)
                ) {
                    throw new Error(
                        "Invalid custom dessert selection."
                    );
                }

                return sum + PRODUCTS[name];
            }, 0);

            price = treatsTotal + 99;

            details =
                treats.join(", ") +
                " + ₹99 gift packaging";
        }

        // Regular catalogue item
        else {
            if (
                !Object.prototype.hasOwnProperty.call(
                    PRODUCTS,
                    item.name
                )
            ) {
                throw new Error("Invalid product.");
            }

            price = PRODUCTS[item.name];
        }

        subtotal += price * quantity;

        return {
            name: String(item.name),
            price,
            quantity,
            details
        };
    });

    return {
        verifiedItems,
        subtotal
    };
}

// --------------------------------------------------
// ADMIN SESSION TOKEN
// --------------------------------------------------

function createSessionToken() {
    const payload = Buffer.from(
        JSON.stringify({
            exp: Date.now() + SESSION_DURATION
        })
    ).toString("base64url");

    const signature = crypto
        .createHmac("sha256", SESSION_SECRET)
        .update(payload)
        .digest("base64url");

    return payload + "." + signature;
}

function verifySessionToken(token) {
    if (!token || !SESSION_SECRET) {
        return false;
    }

    const parts = token.split(".");

    if (parts.length !== 2) {
        return false;
    }

    const [payload, signature] = parts;

    const expectedSignature = crypto
        .createHmac("sha256", SESSION_SECRET)
        .update(payload)
        .digest();

    const receivedSignature = Buffer.from(
        signature,
        "base64url"
    );

    if (
        receivedSignature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(
            receivedSignature,
            expectedSignature
        )
    ) {
        return false;
    }

    try {
        const data = JSON.parse(
            Buffer.from(payload, "base64url").toString()
        );

        return (
            Number.isFinite(data.exp) &&
            data.exp > Date.now()
        );
    } catch {
        return false;
    }
}

// --------------------------------------------------
// COOKIE HELPERS
// --------------------------------------------------

function getCookie(req, name) {
    const cookies = (req.headers.cookie || "").split(";");

    for (const cookie of cookies) {
        const index = cookie.indexOf("=");

        if (index === -1) {
            continue;
        }

        const key = cookie.slice(0, index).trim();

        if (key === name) {
            return cookie.slice(index + 1).trim();
        }
    }

    return "";
}

// --------------------------------------------------
// ADMIN AUTHENTICATION MIDDLEWARE
// --------------------------------------------------

function requireAdmin(req, res, next) {
    const token = getCookie(req, COOKIE_NAME);

    if (!verifySessionToken(token)) {
        return res.status(401).json({
            success: false,
            message: "Admin login required."
        });
    }

    next();
}

// --------------------------------------------------
// ORIGIN PROTECTION
// --------------------------------------------------

function checkSameOrigin(req, res, next) {
    const origin = req.get("origin");

    if (!origin) {
        return res.status(403).json({
            success: false,
            message: "Request origin not allowed."
        });
    }

    try {
        const originHost = new URL(origin).host;
        const requestHost = req.get("host");

        if (originHost !== requestHost) {
            return res.status(403).json({
                success: false,
                message: "Request origin not allowed."
            });
        }
    } catch {
        return res.status(403).json({
            success: false,
            message: "Invalid request origin."
        });
    }

    next();
}

// --------------------------------------------------
// LOGIN RATE LIMITER
// --------------------------------------------------

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 5,
    standardHeaders: true,
    legacyHeaders: false,

    message: {
        success: false,
        message: "Too many login attempts. Try again later."
    }
});

// --------------------------------------------------
// BLOCK ACCESS TO SERVER FILES
// --------------------------------------------------

app.use((req, res, next) => {
    const blockedFiles = [
        "/server.js",
        "/package.json",
        "/package-lock.json",
        "/.env"
    ];

    if (blockedFiles.includes(req.path)) {
        return res.sendStatus(404);
    }

    next();
});

// --------------------------------------------------
// STATIC WEBSITE FILES
// --------------------------------------------------

app.use(express.static(__dirname));

// --------------------------------------------------
// CUSTOM DESSERT BOX DETAILS
// --------------------------------------------------

function formatItemDetails(item) {
    if (!item.details) {
        return "";
    }

    const treats = String(item.details)
        .replace(/\+\s*₹99\s*gift packaging/i, "")
        .split(",")
        .map(name => name.trim())
        .filter(Boolean);

    let output = "\n";

    treats.forEach((treat, index) => {
        const prefix =
            index === treats.length - 1
                ? "  └ "
                : "  ├ ";

        output += `${prefix}${cleanText(treat)}\n`;
    });

    output += "  └ Gift packaging: ₹99\n";

    return output;
}

// --------------------------------------------------
// TELEGRAM NOTIFICATION
// --------------------------------------------------

async function sendTelegramMessage(message) {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

    if (!BOT_TOKEN || !CHAT_ID) {
        throw new Error(
            "Telegram configuration is missing."
        );
    }

    const url =
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

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
        throw new Error(
            result.description || "Telegram notification failed."
        );
    }

    return result;
}

// --------------------------------------------------
// ORDER ID GENERATOR
// --------------------------------------------------

function generateOrderId() {
    return (
        "CC" +
        Date.now().toString().slice(-6) +
        crypto.randomInt(10, 100)
    );
}

// ==================================================
// CUSTOMER API - PLACE ORDER
// ==================================================

app.post("/api/order", async (req, res) => {
    try {
        if (!requireDatabase(res)) {
            return;
        }

        const order = req.body;

        // Validate customer information
        if (
            !order ||
            typeof order.name !== "string" ||
            !order.name.trim() ||
            order.name.length > 100 ||
            typeof order.phone !== "string" ||
            !order.phone.trim() ||
            order.phone.length > 30 ||
            typeof order.address !== "string" ||
            !order.address.trim() ||
            order.address.length > 1000
        ) {
            return res.status(400).json({
                success: false,
                message: "Please provide complete order details."
            });
        }

        // Verify items and prices
        const { verifiedItems, subtotal } =
            validateItems(order.items);

        // Verify coupon
        const coupon = String(order.coupon || "")
            .trim()
            .toUpperCase()
            .slice(0, 30);

        const discount = calculateDiscount(
            subtotal,
            coupon
        );

        const total = subtotal - discount;

        // Generate server-side order ID
        const orderId = generateOrderId();

        // Prepare database record
        const savedOrder = {
            order_id: orderId,
            customer_name: order.name.trim(),
            phone: order.phone.trim(),
            address: order.address.trim(),
            payment: cleanText(order.payment, 100),
            note: cleanText(order.note, 1000),
            items: verifiedItems,
            subtotal,
            coupon,
            discount,
            total,
            status: "Order Placed"
        };

        // Save order first
        const { error } = await supabase
            .from("orders")
            .insert(savedOrder);

        if (error) {
            console.error(
                "Supabase order error:",
                error.message
            );

            return res.status(500).json({
                success: false,
                message: "Unable to save order. Please try again."
            });
        }

        // Prepare Telegram item list
        const itemMessages = verifiedItems.map(item => {
            let message =
                `• ${cleanText(item.name)} x ${item.quantity}\n` +
                `  ${money(item.price)} × ${item.quantity} = ` +
                `${money(item.price * item.quantity)}\n`;

            if (item.details) {
                message += formatItemDetails(item);
            }

            return message;
        });

        const couponMessage = coupon
            ? discount > 0
                ? `${coupon} (Applied)`
                : `${coupon} (Not applied)`
            : "None";

        // Complete order notification
        const telegramMessage = `
🍫 NEW CHOCO CRAZE ORDER!

🆔 Order ID: ${orderId}

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

        // Telegram notification (order already saved)
        let notificationSent = true;

        try {
            await sendTelegramMessage(telegramMessage);
        } catch (telegramError) {
            notificationSent = false;

            console.error(
                "Telegram error:",
                telegramError.message
            );
        }

        return res.json({
            success: true,
            message: "Your order has been placed!",
            orderId,
            subtotal,
            discount,
            total,
            notificationSent
        });

    } catch (error) {
        console.error("Order error:", error.message);

        return res.status(400).json({
            success: false,
            message: error.message || "Could not place order."
        });
    }
});

// ==================================================
// CUSTOMER API - TRACK ORDER
// ==================================================

app.post("/api/track", async (req, res) => {
    try {
        if (!requireDatabase(res)) {
            return;
        }

        const orderId = String(
            req.body.orderId || ""
        ).trim();

        const phone = String(
            req.body.phone || ""
        ).trim();

        if (!orderId || !phone) {
            return res.status(400).json({
                success: false,
                message: "Enter your order ID and phone number."
            });
        }

        const { data, error } = await supabase
            .from("orders")
            .select(
                "order_id, customer_name, items, total, status, created_at, updated_at"
            )
            .eq("order_id", orderId)
            .eq("phone", phone)
            .maybeSingle();

        if (error) {
            throw error;
        }

        if (!data) {
            return res.status(404).json({
                success: false,
                message: "No matching order found. Check your order ID and phone number."
            });
        }

        return res.json({
            success: true,
            order: data
        });

    } catch (error) {
        console.error(
            "Tracking error:",
            error.message
        );

        return res.status(500).json({
            success: false,
            message: "Unable to track order right now."
        });
    }
});

// ==================================================
// ADMIN API - LOGIN
// ==================================================

app.post(
    "/api/admin/login",
    loginLimiter,
    checkSameOrigin,
    (req, res) => {
        if (!ADMIN_PASSWORD || !SESSION_SECRET) {
            return res.status(503).json({
                success: false,
                message: "Admin login is not configured."
            });
        }

        const password = String(
            req.body.password || ""
        );

        const expected = Buffer.from(ADMIN_PASSWORD);
        const received = Buffer.from(password);

        const valid =
            expected.length === received.length &&
            crypto.timingSafeEqual(
                expected,
                received
            );

        if (!valid) {
            return res.status(401).json({
                success: false,
                message: "Incorrect admin password."
            });
        }

        const token = createSessionToken();

        res.cookie(COOKIE_NAME, token, {
            ...cookieOptions,
            maxAge: SESSION_DURATION
        });

        return res.json({
            success: true,
            message: "Admin login successful."
        });
    }
);

// ==================================================
// ADMIN API - CHECK SESSION
// ==================================================

app.get(
    "/api/admin/session",
    requireAdmin,
    (req, res) => {
        res.json({
            success: true,
            message: "Admin session active."
        });
    }
);

// ==================================================
// ADMIN API - LOGOUT
// ==================================================

app.post(
    "/api/admin/logout",
    checkSameOrigin,
    requireAdmin,
    (req, res) => {
        res.clearCookie(
            COOKIE_NAME,
            cookieOptions
        );

        return res.json({
            success: true,
            message: "Logged out successfully."
        });
    }
);

// ==================================================
// ADMIN API - GET ALL ORDERS
// ==================================================

app.get(
    "/api/admin/orders",
    requireAdmin,
    async (req, res) => {
        try {
            if (!requireDatabase(res)) {
                return;
            }

            const { data, error } = await supabase
                .from("orders")
                .select("*")
                .order("created_at", {
                    ascending: false
                });

            if (error) {
                throw error;
            }

            return res.json({
                success: true,
                orders: data
            });

        } catch (error) {
            console.error(
                "Admin orders error:",
                error.message
            );

            return res.status(500).json({
                success: false,
                message: "Unable to load orders."
            });
        }
    }
);

// ==================================================
// ADMIN API - UPDATE ORDER STATUS
// ==================================================

app.patch(
    "/api/admin/orders/:id/status",
    checkSameOrigin,
    requireAdmin,
    async (req, res) => {
        try {
            if (!requireDatabase(res)) {
                return;
            }

            const status = req.body.status;

            if (!ORDER_STATUSES.includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid order status."
                });
            }

            const { data, error } = await supabase
                .from("orders")
                .update({
                    status,
                    updated_at: new Date().toISOString()
                })
                .eq("order_id", req.params.id)
                .select(
                    "order_id, status, updated_at"
                )
                .maybeSingle();

            if (error) {
                throw error;
            }

            if (!data) {
                return res.status(404).json({
                    success: false,
                    message: "Order not found."
                });
            }

            return res.json({
                success: true,
                order: data
            });

        } catch (error) {
            console.error(
                "Status update error:",
                error.message
            );

            return res.status(500).json({
                success: false,
                message: "Unable to update order status."
            });
        }
    }
);

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(PORT, () => {
    console.log(
        `Choco Craze server running on port ${PORT}`
    );
});
