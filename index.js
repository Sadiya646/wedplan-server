import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import jwt from "jsonwebtoken";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const escapeRegex = (str) =>
  String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "https://wedplan-client-coral.vercel.app",
    ],
    credentials: true,
  })
);

// MongoDB Atlas Connection
const uri =
  process.env.MONGODB_URI ||
  process.env.BETTER_AUTH_DB_URI ||
  process.env.MONGO_URI;

if (!uri) {
  console.error("Missing MONGODB_URI in environment variables.");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const dbName = process.env.MONGODB_DB_NAME || "wedplan";
const db = client.db(dbName);
const servicesCollection = db.collection("services");
const bookingsCollection = db.collection("bookings");
const usersCollection = db.collection("user");
const transactionsCollection = db.collection("transactions");

// ==========================================
// STRIPE WEBHOOK ROUTE (MUST BE BEFORE express.json())
// ==========================================
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
        return res
          .status(500)
          .send("Stripe or STRIPE_WEBHOOK_SECRET is not configured on server");
      }

      const sig = req.headers["stripe-signature"];
      let event;

      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error("Webhook signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const vendorEmail = String(
          session.metadata?.email || session.customer_details?.email || ""
        )
          .trim()
          .toLowerCase();

        if (vendorEmail) {
          const emailQuery = {
            email: { $regex: new RegExp(`^${escapeRegex(vendorEmail)}$`, "i") },
          };
          const vendor = await usersCollection.findOne(emailQuery);

          await usersCollection.updateOne(emailQuery, {
            $set: {
              subscriptionPlan: "PREMIUM",
              plan: "PREMIUM",
              stripeCustomerId: session.customer || "",
              stripeSubscriptionId: session.subscription || "",
              upgradedAt: new Date(),
              updatedAt: new Date(),
            },
          });

          const existingTx = await transactionsCollection.findOne({
            stripeSessionId: session.id,
          });

          if (!existingTx) {
            await transactionsCollection.insertOne({
              vendorId: vendor?._id ? String(vendor._id) : "",
              vendorName: vendor?.businessName || vendor?.name || "Vendor",
              vendorEmail,
              plan: "PREMIUM",
              amount: session.amount_total ? session.amount_total / 100 : 29,
              currency: (session.currency || "usd").toUpperCase(),
              stripeSessionId: session.id,
              stripeSubscriptionId: session.subscription || "",
              status: "SUCCESS",
              createdAt: new Date(),
            });
          }
        }
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        await usersCollection.updateOne(
          { stripeSubscriptionId: subscription.id },
          {
            $set: {
              subscriptionPlan: "FREE",
              plan: "FREE",
              updatedAt: new Date(),
            },
          }
        );
      }

      return res.status(200).json({ received: true });
    } catch (error) {
      console.error("POST /api/webhooks/stripe error:", error);
      return res.status(500).json({ message: "Webhook processing failed" });
    }
  }
);

// JSON parser MUST come AFTER /api/webhooks/stripe
app.use(express.json());

async function startServer() {
  try {
    await client.connect();
    await db.command({ ping: 1 });
    console.log(`Connected to MongoDB Atlas database: "${dbName}"`);

    // Temporary session endpoint for Navbar useSession() when Better Auth route isn't mounted here
    app.get("/api/auth/get-session", (req, res) => {
      res.json(null);
    });

    // Health check route
    app.get("/", (req, res) => {
      res.send("WedPlan Server is running!");
    });

    // ==========================================
    // USER ROLE & PROFILE ROUTES
    // ==========================================

    // Get role & subscription status by user email
    app.get("/api/users/role", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email || !String(email).trim()) {
          return res.status(400).json({ message: "Email is required" });
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const foundUser = await usersCollection.findOne(
          {
            email: {
              $regex: new RegExp(`^${escapeRegex(cleanEmail)}$`, "i"),
            },
          },
          {
            projection: {
              role: 1,
              isBlocked: 1,
              businessName: 1,
              subscriptionPlan: 1,
              plan: 1,
            },
          }
        );

        res.status(200).json({
          role: foundUser?.role || "customer",
          isBlocked: Boolean(foundUser?.isBlocked),
          businessName: foundUser?.businessName || "",
          subscriptionPlan:
            foundUser?.subscriptionPlan || foundUser?.plan || "FREE",
        });
      } catch (error) {
        console.error("GET /api/users/role error:", error);
        res.status(500).json({ message: "Failed to fetch user role" });
      }
    });

    // Get user profile & subscription plan by email
    app.get("/api/users/profile", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email || !String(email).trim()) {
          return res.status(400).json({ message: "Email is required" });
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const emailQuery = {
          email: { $regex: new RegExp(`^${escapeRegex(cleanEmail)}$`, "i") },
        };

        const foundUser = await usersCollection.findOne(emailQuery, {
          projection: {
            name: 1,
            email: 1,
            role: 1,
            phone: 1,
            eventLocation: 1,
            eventDate: 1,
            image: 1,
            subscriptionPlan: 1,
            plan: 1,
            stripeCustomerId: 1,
            stripeSubscriptionId: 1,
            upgradedAt: 1,
          },
        });

        if (!foundUser) {
          return res.status(404).json({ message: "User not found" });
        }

        res.status(200).json({ user: foundUser });
      } catch (error) {
        console.error("GET /api/users/profile error:", error);
        res.status(500).json({ message: "Failed to load profile" });
      }
    });

    // Update user profile ONLY (role & subscriptionPlan cannot be self-modified here)
    app.patch("/api/users/profile", async (req, res) => {
      try {
        const { email, name, phone, eventLocation, eventDate, image } =
          req.body;

        if (!email || !String(email).trim()) {
          return res.status(400).json({ message: "Email is required" });
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const emailQuery = {
          email: { $regex: new RegExp(`^${escapeRegex(cleanEmail)}$`, "i") },
        };

        const updateFields = { updatedAt: new Date() };

        if (name !== undefined && String(name).trim()) {
          updateFields.name = String(name).trim();
        }
        if (phone !== undefined) {
          updateFields.phone = String(phone).trim();
        }
        if (eventLocation !== undefined) {
          updateFields.eventLocation = String(eventLocation).trim();
        }
        if (eventDate !== undefined) {
          updateFields.eventDate = String(eventDate).trim();
        }
        if (image !== undefined) {
          updateFields.image = String(image).trim();
        }

        const result = await usersCollection.updateOne(emailQuery, {
          $set: updateFields,
        });

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "User not found" });
        }

        const updatedUser = await usersCollection.findOne(emailQuery, {
          projection: {
            name: 1,
            email: 1,
            role: 1,
            phone: 1,
            eventLocation: 1,
            eventDate: 1,
            image: 1,
            subscriptionPlan: 1,
            plan: 1,
            upgradedAt: 1,
          },
        });

        res.status(200).json({
          message: "Profile updated successfully",
          user: updatedUser,
        });
      } catch (error) {
        console.error("PATCH /api/users/profile error:", error);
        res.status(500).json({ message: "Failed to update profile" });
      }
    });

    // Record user sign-in timestamp & count
    app.post("/api/users/login-activity", async (req, res) => {
      try {
        const { email } = req.body;
        if (!email || !String(email).trim()) {
          return res.status(400).json({ message: "Email is required" });
        }

        const cleanEmail = String(email).trim().toLowerCase();
        await usersCollection.updateOne(
          { email: cleanEmail },
          {
            $set: { lastLoginAt: new Date() },
            $inc: { loginCount: 1 },
          }
        );

        res.status(200).json({ message: "Login activity recorded" });
      } catch (error) {
        console.error("POST /api/users/login-activity error:", error);
        res.status(500).json({ message: "Failed to record login activity" });
      }
    });

    // ==========================================
    // ADMIN PORTAL ROUTES
    // ==========================================

    // 1. Get all users (Admin)
    app.get("/api/admin/users", async (req, res) => {
      try {
        const users = await usersCollection
          .find(
            {},
            {
              projection: {
                name: 1,
                email: 1,
                role: 1,
                businessName: 1,
                subscriptionPlan: 1,
                plan: 1,
                isBlocked: 1,
                loginCount: 1,
                lastLoginAt: 1,
                createdAt: 1,
              },
            }
          )
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({ users });
      } catch (error) {
        console.error("GET /api/admin/users error:", error);
        res.status(500).json({ message: "Failed to fetch users" });
      }
    });

    // Admin: Get ALL services (Pending, Approved, Rejected)
    app.get("/api/admin/services", async (req, res) => {
      try {
        const services = await servicesCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();
        res.status(200).json({ services });
      } catch (error) {
        res.status(500).json({ message: "Failed to fetch all services" });
      }
    });

    // Admin: Approve or Reject a service
    app.patch("/api/admin/services/:id/status", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid service ID" });
        }
        if (!["APPROVED", "REJECTED", "PENDING"].includes(status)) {
          return res.status(400).json({ message: "Invalid status" });
        }

        const result = await servicesCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "Service not found" });
        }

        res.status(200).json({ message: `Service marked as ${status}` });
      } catch (error) {
        res.status(500).json({ message: "Failed to update service status" });
      }
    });

    // 2. Update user role or block status (Admin)
    app.patch("/api/admin/users/:id", async (req, res) => {
      try {
        const { id } = req.params;
        const { role, isBlocked } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid user ID" });
        }

        const updateFields = { updatedAt: new Date() };
        const allowedRoles = ["customer", "vendor", "admin"];

        if (role !== undefined) {
          if (!allowedRoles.includes(role)) {
            return res.status(400).json({ message: "Invalid role value" });
          }
          updateFields.role = role;
        }

        if (typeof isBlocked === "boolean") {
          updateFields.isBlocked = isBlocked;
        }

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateFields }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "User not found" });
        }

        res.status(200).json({ message: "User updated successfully" });
      } catch (error) {
        console.error("PATCH /api/admin/users/:id error:", error);
        res.status(500).json({ message: "Failed to update user" });
      }
    });

    // 3. Get all bookings (Admin)
    app.get("/api/admin/bookings", async (req, res) => {
      try {
        const bookings = await bookingsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({ bookings });
      } catch (error) {
        console.error("GET /api/admin/bookings error:", error);
        res.status(500).json({ message: "Failed to fetch bookings" });
      }
    });

    // 4. Get all subscription transactions (Admin)
    app.get("/api/admin/transactions", async (req, res) => {
      try {
        const transactions = await transactionsCollection
          .find({})
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({ transactions });
      } catch (error) {
        console.error("GET /api/admin/transactions error:", error);
        res.status(500).json({ message: "Failed to fetch transactions" });
      }
    });

    // 5. Server-side Stripe session verification (syncs DB if webhook hasn't arrived yet)
    app.post("/api/stripe/verify-session", async (req, res) => {
      try {
        if (!stripe) {
          return res
            .status(500)
            .json({ message: "STRIPE_SECRET_KEY is missing on Express server" });
        }

        const { sessionId } = req.body;
        if (!sessionId || !String(sessionId).trim()) {
          return res.status(400).json({ message: "sessionId is required" });
        }

        const session = await stripe.checkout.sessions.retrieve(
          String(sessionId).trim()
        );

        const isPaid =
          session.payment_status === "paid" || session.status === "complete";

        if (!isPaid) {
          return res.status(400).json({
            verified: false,
            message: "Payment is not completed yet",
          });
        }

        const vendorEmail = String(
          session.metadata?.email || session.customer_details?.email || ""
        )
          .trim()
          .toLowerCase();

        if (!vendorEmail) {
          return res
            .status(400)
            .json({ message: "Vendor email not found in Stripe session" });
        }

        const emailQuery = {
          email: { $regex: new RegExp(`^${escapeRegex(vendorEmail)}$`, "i") },
        };
        const vendor = await usersCollection.findOne(emailQuery);

        await usersCollection.updateOne(emailQuery, {
          $set: {
            subscriptionPlan: "PREMIUM",
            plan: "PREMIUM",
            stripeCustomerId:
              typeof session.customer === "string" ? session.customer : "",
            stripeSubscriptionId:
              typeof session.subscription === "string"
                ? session.subscription
                : "",
            upgradedAt: new Date(),
            updatedAt: new Date(),
          },
        });

        const existingTx = await transactionsCollection.findOne({
          stripeSessionId: session.id,
        });

        if (!existingTx) {
          await transactionsCollection.insertOne({
            vendorId: vendor?._id ? String(vendor._id) : "",
            vendorName: vendor?.businessName || vendor?.name || "Vendor",
            vendorEmail,
            plan: "PREMIUM",
            amount: session.amount_total ? session.amount_total / 100 : 29,
            currency: (session.currency || "usd").toUpperCase(),
            stripeSessionId: session.id,
            stripeSubscriptionId:
              typeof session.subscription === "string"
                ? session.subscription
                : "",
            status: "SUCCESS",
            createdAt: new Date(),
          });
        }

        return res.status(200).json({
          verified: true,
          subscriptionPlan: "PREMIUM",
          email: vendorEmail,
        });
      } catch (error) {
        console.error("POST /api/stripe/verify-session error:", error);
        return res.status(500).json({ message: error.message });
      }
    });

    // ==========================================
    // VENDOR & PUBLIC SERVICES CRUD ROUTES
    // ==========================================

    // 1. Get all services created by a specific vendor
    app.get("/api/services/vendor", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email || !String(email).trim()) {
          return res
            .status(400)
            .json({ message: "Vendor email is required" });
        }

        const services = await servicesCollection
          .find({ vendorEmail: String(email).trim() })
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({ services });
      } catch (error) {
        console.error("GET /api/services/vendor error:", error);
        res.status(500).json({ message: "Failed to fetch vendor services" });
      }
    });

    // 2. Get public services for Browse Services / Home (ONLY APPROVED & ACTIVE)
    app.get("/api/services", async (req, res) => {
      try {
        const { category, search, location, sort } = req.query;
        const query = {
          status: "APPROVED",
          isAvailable: { $ne: false },
        };

        if (category && String(category) !== "All") {
          query.category = String(category).trim();
        }

        if (location && String(location).trim()) {
          query.location = new RegExp(escapeRegex(String(location).trim()), "i");
        }

        if (search && String(search).trim()) {
          const regex = new RegExp(escapeRegex(String(search).trim()), "i");
          query.$or = [
            { title: regex },
            { vendorName: regex },
            { location: regex },
            { category: regex },
          ];
        }

        let cursor = servicesCollection.find(query);

        if (sort === "price-asc") {
          cursor = cursor.sort({ price: 1, createdAt: -1 });
        } else if (sort === "price-desc") {
          cursor = cursor.sort({ price: -1, createdAt: -1 });
        } else if (sort === "rating-desc") {
          cursor = cursor.sort({ rating: -1, createdAt: -1 });
        } else {
          cursor = cursor.sort({ createdAt: -1 });
        }

        const services = await cursor.toArray();
        res.status(200).json({ services });
      } catch (error) {
        console.error("GET /api/services error:", error);
        res.status(500).json({ message: "Failed to fetch services" });
      }
    });

    // 3. Get single service details by ID
    app.get("/api/services/:id", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid service ID" });
        }

        const service = await servicesCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!service) {
          return res.status(404).json({ message: "Service not found" });
        }

        res.status(200).json({ service });
      } catch (error) {
        console.error("GET /api/services/:id error:", error);
        res.status(500).json({ message: "Failed to load service details" });
      }
    });

    // 4. Create a new service (Vendor, with FREE plan 3-service server-side limit)
    app.post("/api/services", async (req, res) => {
      try {
        const {
          title,
          category,
          location,
          price,
          summary,
          image,
          vendorEmail,
          vendorName,
        } = req.body;

        const numericPrice = Number(price);
        if (
          !title ||
          !String(title).trim() ||
          !category ||
          !String(category).trim() ||
          !location ||
          !String(location).trim() ||
          Number.isNaN(numericPrice) ||
          numericPrice <= 0 ||
          !vendorEmail ||
          !String(vendorEmail).trim()
        ) {
          return res
            .status(400)
            .json({ message: "Missing or invalid required service fields" });
        }

        const cleanVendorEmail = String(vendorEmail).trim().toLowerCase();
        const vendorUser = await usersCollection.findOne({
          email: {
            $regex: new RegExp(`^${escapeRegex(cleanVendorEmail)}$`, "i"),
          },
        });

        if (vendorUser?.isBlocked) {
          return res
            .status(403)
            .json({ message: "Blocked accounts cannot publish services" });
        }

        const currentPlan = (
          vendorUser?.subscriptionPlan ||
          vendorUser?.plan ||
          "FREE"
        ).toUpperCase();

        if (currentPlan !== "PREMIUM") {
          const existingCount = await servicesCollection.countDocuments({
            vendorEmail: {
              $regex: new RegExp(`^${escapeRegex(cleanVendorEmail)}$`, "i"),
            },
          });

          if (existingCount >= 3) {
            return res.status(403).json({
              message:
                "Free plan allows up to 3 services. Upgrade to Vendor Premium for unlimited listings.",
            });
          }
        }

        const newService = {
          title: String(title).trim(),
          category: String(category).trim(),
          location: String(location).trim(),
          price: numericPrice,
          summary: String(summary || "").trim(),
          image: String(image || "").trim(),
          vendorEmail: String(vendorEmail).trim(),
          vendorName: String(vendorName || "Verified Studio").trim(),
          rating: 5.0,
          status: "PENDING",
          isAvailable: true,
          createdAt: new Date(),
        };

        const result = await servicesCollection.insertOne(newService);
        res.status(201).json({
          message: "Service created successfully",
          service: { ...newService, _id: result.insertedId },
        });
      } catch (error) {
        console.error("POST /api/services error:", error);
        res.status(500).json({ message: "Failed to create service" });
      }
    });

    // 5. Update an existing service (Vendor)
    app.patch("/api/services/:id", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid service ID" });
        }

        const {
          title,
          category,
          location,
          price,
          summary,
          image,
          isAvailable,
        } = req.body;
        const updateFields = {
          updatedAt: new Date(),
        };

        if (title !== undefined) {
          if (!String(title).trim()) {
            return res
              .status(400)
              .json({ message: "Service title cannot be empty" });
          }
          updateFields.title = String(title).trim();
        }

        if (category !== undefined && String(category).trim()) {
          updateFields.category = String(category).trim();
        }

        if (location !== undefined && String(location).trim()) {
          updateFields.location = String(location).trim();
        }

        if (price !== undefined) {
          const numericPrice = Number(price);
          if (Number.isNaN(numericPrice) || numericPrice <= 0) {
            return res
              .status(400)
              .json({ message: "Price must be a valid positive number" });
          }
          updateFields.price = numericPrice;
        }

        if (summary !== undefined) {
          updateFields.summary = String(summary).trim();
        }

        if (image !== undefined) {
          updateFields.image = String(image).trim();
        }

        if (typeof isAvailable === "boolean") {
          updateFields.isAvailable = isAvailable;
        }

        const result = await servicesCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateFields }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "Service not found" });
        }

        const updatedService = await servicesCollection.findOne({
          _id: new ObjectId(id),
        });

        res.status(200).json({
          message: "Service updated successfully",
          service: updatedService,
        });
      } catch (error) {
        console.error("PATCH /api/services/:id error:", error);
        res.status(500).json({ message: "Failed to update service" });
      }
    });

    // 6. Delete a service (Vendor)
    app.delete("/api/services/:id", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid service ID" });
        }

        const result = await servicesCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({ message: "Service not found" });
        }

        res.status(200).json({ message: "Service deleted successfully" });
      } catch (error) {
        console.error("DELETE /api/services/:id error:", error);
        res.status(500).json({ message: "Failed to delete service" });
      }
    });

    // ==========================================
    // VENDOR & CUSTOMER BOOKINGS ROUTES
    // ==========================================

    // 7. Get all bookings for a specific vendor
    app.get("/api/bookings/vendor", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email || !String(email).trim()) {
          return res
            .status(400)
            .json({ message: "Vendor email is required" });
        }

        const bookings = await bookingsCollection
          .find({ vendorEmail: String(email).trim() })
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({ bookings });
      } catch (error) {
        console.error("GET /api/bookings/vendor error:", error);
        res.status(500).json({ message: "Failed to fetch vendor bookings" });
      }
    });

    // 8. Accept or Reject a booking request (Vendor)
    app.patch("/api/bookings/:id/status", async (req, res) => {
      try {
        const { id } = req.params;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid booking ID" });
        }

        if (!["ACCEPTED", "REJECTED"].includes(status)) {
          return res
            .status(400)
            .json({ message: "Status must be ACCEPTED or REJECTED" });
        }

        const result = await bookingsCollection.updateOne(
          { _id: new ObjectId(id), status: "PENDING" },
          { $set: { status, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
          return res
            .status(400)
            .json({ message: "Booking not found or already processed" });
        }

        res.status(200).json({ message: `Booking status updated to ${status}` });
      } catch (error) {
        console.error("PATCH /api/bookings/:id/status error:", error);
        res.status(500).json({ message: "Failed to update booking status" });
      }
    });

    // 9. Get all bookings for a customer
    app.get("/api/bookings/customer", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email || !String(email).trim()) {
          return res
            .status(400)
            .json({ message: "Customer email is required" });
        }

        const bookings = await bookingsCollection
          .find({ customerEmail: String(email).trim() })
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json({ bookings });
      } catch (error) {
        console.error("GET /api/bookings/customer error:", error);
        res.status(500).json({ message: "Failed to fetch customer bookings" });
      }
    });

    // 10. Create a new booking request
    app.post("/api/bookings", async (req, res) => {
      try {
        const {
          serviceId,
          serviceTitle,
          vendorEmail,
          vendorName,
          customerEmail,
          customerName,
          eventDate,
          guestCount,
          notes,
          price,
        } = req.body;

        if (
          !serviceTitle ||
          !String(serviceTitle).trim() ||
          !customerEmail ||
          !String(customerEmail).trim() ||
          !eventDate ||
          !String(eventDate).trim()
        ) {
          return res
            .status(400)
            .json({ message: "Missing required booking fields" });
        }

        if (
          vendorEmail &&
          String(vendorEmail).trim().toLowerCase() ===
            String(customerEmail).trim().toLowerCase()
        ) {
          return res
            .status(400)
            .json({ message: "You cannot book your own service" });
        }

        // Check if customer is blocked or admin
        const customerUser = await usersCollection.findOne({
          email: {
            $regex: new RegExp(
              `^${escapeRegex(String(customerEmail).trim())}$`,
              "i"
            ),
          },
        });

        if (customerUser?.isBlocked) {
          return res
            .status(403)
            .json({ message: "Blocked accounts cannot submit bookings" });
        }

        if (customerUser?.role === "admin") {
          return res
            .status(403)
            .json({ message: "Admins cannot submit customer booking requests" });
        }

        // Prevent duplicate active booking for same service & eventDate
        if (serviceId) {
          const duplicate = await bookingsCollection.findOne({
            serviceId: String(serviceId).trim(),
            eventDate: String(eventDate).trim(),
            status: { $in: ["PENDING", "ACCEPTED"] },
          });

          if (duplicate) {
            return res.status(409).json({
              message:
                "An active booking request already exists for this service on the selected date.",
            });
          }
        }

        const newBooking = {
          serviceId: String(serviceId || "").trim(),
          serviceTitle: String(serviceTitle).trim(),
          vendorEmail: String(vendorEmail || "").trim(),
          vendorName: String(vendorName || "Verified Studio").trim(),
          customerEmail: String(customerEmail).trim(),
          customerName: String(customerName || "Couple").trim(),
          eventDate: String(eventDate).trim(),
          guestCount: Number(guestCount) || 100,
          notes: String(notes || "").trim(),
          price: Number(price) || 0,
          status: "PENDING",
          createdAt: new Date(),
        };

        const result = await bookingsCollection.insertOne(newBooking);
        res.status(201).json({
          message: "Booking request submitted",
          booking: { ...newBooking, _id: result.insertedId },
        });
      } catch (error) {
        console.error("POST /api/bookings error:", error);
        res.status(500).json({ message: "Failed to create booking request" });
      }
    });






// ==========================================
// JWT & ROLE VERIFICATION MIDDLEWARE
// ==========================================
const verifyJWT = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ message: "Unauthorized: Missing Bearer token" });
    }

    const token = authHeader.split(" ")[1];
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res
        .status(500)
        .json({ message: "Server JWT_SECRET is not configured" });
    }

    const decoded = jwt.verify(token, secret);
    const cleanEmail = String(decoded.email || "").trim().toLowerCase();

    // Always verify real role & blocked status from MongoDB
    const dbUser = await usersCollection.findOne({
      email: { $regex: new RegExp(`^${escapeRegex(cleanEmail)}$`, "i") },
    });

    if (!dbUser) {
      return res.status(401).json({ message: "Unauthorized: User not found" });
    }

    if (dbUser.isBlocked) {
      return res
        .status(403)
        .json({ message: "Forbidden: Your account has been blocked" });
    }

    req.user = {
      id: String(dbUser._id),
      email: dbUser.email,
      role: dbUser.role || "customer",
      subscriptionPlan: dbUser.subscriptionPlan || dbUser.plan || "FREE",
    };

    next();
  } catch (error) {
    return res
      .status(401)
      .json({ message: "Unauthorized: Invalid or expired token" });
  }
};

const verifyRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res
        .status(403)
        .json({ message: "Forbidden: Insufficient permissions" });
    }
    next();
  };
};


    // 11. Cancel a pending booking
    app.patch("/api/bookings/:id/cancel", async (req, res) => {
      try {
        const { id } = req.params;
        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid booking ID" });
        }

        const result = await bookingsCollection.updateOne(
          { _id: new ObjectId(id), status: "PENDING" },
          { $set: { status: "CANCELLED", updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
          return res
            .status(400)
            .json({ message: "Only pending bookings can be cancelled" });
        }

        res.status(200).json({ message: "Booking cancelled successfully" });
      } catch (error) {
        console.error("PATCH /api/bookings/:id/cancel error:", error);
        res.status(500).json({ message: "Failed to cancel booking" });
      }
    });

    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();