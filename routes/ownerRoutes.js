const express = require("express");
const router = express.Router();
const verifyToken = require("../middlewares/verifyToken");
const requireOwner = require("../middlewares/requireOwner");
const requireAdmin = require("../middlewares/requireAdmin");
const preventDuplicate = require("../middlewares/preventDuplicate");
const ownerController = require("../controllers/ownerController");

router.get(
  "/owner/resorts",
  verifyToken,
  requireOwner,
  ownerController.getMyResorts,
);
router.get(
  "/owner/bookings",
  verifyToken,
  requireOwner,
  ownerController.getMyBookings,
);
router.get(
  "/owner/reviews",
  verifyToken,
  requireOwner,
  ownerController.getMyReviews,
);
router.get(
  "/owner/revenue",
  verifyToken,
  requireOwner,
  ownerController.getMyRevenue,
);
router.put(
  "/owner/change-password",
  verifyToken,
  requireOwner,
  ownerController.changePassword,
);
// Admin: manage owner accounts
router.get(
  "/owners",
  verifyToken,
  requireAdmin,
  ownerController.adminGetAllOwners,
);
router.put(
  "/owners/:id",
  verifyToken,
  requireAdmin,
  preventDuplicate((req) => `owner_update:${req.params.id}`),
  ownerController.adminUpdateOwner,
);
router.delete(
  "/owners/:id",
  verifyToken,
  requireAdmin,
  preventDuplicate((req) => `owner_delete:${req.params.id}`),
  ownerController.adminDeleteOwner,
);

module.exports = router;
