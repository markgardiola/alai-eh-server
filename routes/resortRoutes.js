const express = require("express");
const router = express.Router();
const resortController = require("../controllers/resortController");
const uploadResortImages = require("../middlewares/uploadResortImage");
const verifyToken = require("../middlewares/verifyToken");
const requireAdmin = require("../middlewares/requireAdmin");
const preventDuplicate = require("../middlewares/preventDuplicate");

router.post(
  "/add_resort",
  verifyToken,
  requireAdmin,
  preventDuplicate((req) => `add_resort:${req.userId}`),
  uploadResortImages.any(),
  resortController.createResort,
);
router.get("/resorts", resortController.getAllResorts);
router.get("/total_resorts", resortController.getTotalResorts);
router.get("/resorts/:id", resortController.getResortById);
router.delete(
  "/resorts/:id",
  verifyToken,
  requireAdmin,
  resortController.deleteResort,
);
router.put(
  "/resorts/:id",
  verifyToken,
  requireAdmin,
  preventDuplicate((req) => `update_resort:${req.params.id}`),
  uploadResortImages.any(),
  resortController.updateResort,
);
router.get(
  "/resorts/barangay/:barangay",
  resortController.getResortsByBarangay,
);

module.exports = router;
