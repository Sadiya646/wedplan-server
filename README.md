

```markdown
# WedPlan Server — Wedding Planning Platform Backend API

WedPlan Server is the backend REST API for **WedPlan**, a role-based wedding planning and vendor marketplace platform built with Node.js, Express.js, and MongoDB. It handles JWT and role-based authorization, service approval workflows, Free/Premium vendor service limits, booking guardrails, and transaction/subscription synchronization.

## Important Features

- **JWT & Role-Based Security:** Bearer token verification middleware (`verifyJWT`), role enforcement (`verifyRole` for `customer`, `vendor`, and `admin`), resource ownership checks, and blocked-user enforcement.
- **Services & Plan Rules:** REST endpoints for wedding services with `Pending` default status on creation, admin approval/rejection moderation, public approved/active service filtering, and Free plan (max 3 active services) vs. Premium plan enforcement.
- **Booking Management & Guardrails:** Booking creation, vendor acceptance/rejection, and customer cancellation of pending bookings, while preventing self-booking and duplicate active bookings for the same service and event date.
- **Transactions & Webhook Sync:** Endpoints and handlers to record verified Stripe transactions and update vendor subscription status (`Free` / `Premium`) without allowing manual payment status spoofing.

## Technology Stack

- **Runtime & Framework:** Node.js, Express.js
- **Database:** MongoDB / MongoDB Atlas
- **Security & Utilities:** JSON Web Tokens (`JWT_SECRET`), CORS, dotenv

## Installation Instructions

1. Clone the server repository:
   ```bash
   git clone https://github.com/Sadiya646/wedplan-server.git
