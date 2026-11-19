import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

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

// Connect to MongoDB once and start server
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
    // USER ROLE LOOKUP ROUTE
    // ==========================================

    // Get role by user email
    app.get("/api/users/role", async (req, res) => {
      try {
        const email = req.query.email;
        if (!email || !String(email).trim()) {
          return res.status(400).json({ message: "Email is required" });
        }

        const foundUser = await usersCollection.findOne(
          { email: String(email).trim() },
          { projection: { role: 1, isBlocked: 1, businessName: 1 } }
        );

        res.status(200).json({
          role: foundUser?.role || "customer",
          isBlocked: Boolean(foundUser?.isBlocked),
          businessName: foundUser?.businessName || "",
        });
      } catch (error) {
        console.error("GET /api/users/role error:", error);
        res.status(500).json({ message: "Failed to fetch user role" });
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

    // 2. Get public services for Browse Services / Home (with search, category, sort)
    app.get("/api/services", async (req, res) => {
      try {
        const { category, search, sort } = req.query;
        const query = {};

        if (category && String(category) !== "All") {
          query.category = String(category).trim();
        }

        if (search && String(search).trim()) {
          const regex = new RegExp(String(search).trim(), "i");
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

    // 4. Create a new service (Vendor)
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
          status: "APPROVED",
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

        const { title, category, location, price, summary, image } = req.body;
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
          { _id: new ObjectId(id) },
          { $set: { status, updatedAt: new Date() } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "Booking not found" });
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