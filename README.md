# WedPlan Server — Wedding Planning Platform Backend API

WedPlan Server is the backend REST API for **WedPlan**, a role-based wedding planning and vendor marketplace platform built with Node.js, Express.js, and MongoDB. It handles JWT and role-based access control, service approval workflows, Free and Premium vendor service limits, booking guardrails, and verified Stripe payment and subscription synchronization.

## Important Features

- **JWT & Role-Based Authorization:** Bearer token verification middleware (`verifyJWT`), role-based access middleware (`verifyRole` for `customer`, `vendor`, and `admin`), resource ownership verification, and blocked-user enforcement.
- **Services & Plan Rules:** Endpoints to create, update, delete, and moderate wedding services with `Pending` default status until admin approval, public approved/active service filtering, and Free plan (maximum 3 active services) versus Premium plan enforcement.
- **Booking Management & Guardrails:** Endpoints for booking creation, vendor acceptance or rejection, and customer cancellation of pending bookings, while preventing self-booking and duplicate active bookings for the same service and event date.
- **Transactions & Subscription Sync:** Endpoints and handlers to record verified Stripe transactions and update vendor subscription status (`Free` or `Premium`) without allowing manual payment status spoofing.

## Technology Stack

- **Runtime & Framework:** Node.js, Express.js
- **Database:** MongoDB / MongoDB Atlas
- **Security & Configuration:** JSON Web Tokens (`JWT_SECRET`), CORS, dotenv

## Installation Instructions

1. Clone the server repository:
   ```bash
   git clone https://github.com/Sadiya646/wedplan-server.git
## How to Run the Project Locally

1. Clone the server repository and Start the backend server (`wedplan-server`):
   ```bash
   cd wedplan-server
   npm run dev   

## Live Link
```bash
wedplan-client-coral.vercel.app
wedplan-server-sooty.vercel.app
