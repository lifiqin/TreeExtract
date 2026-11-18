# Test image provenance

`astronaut.png` is the scikit-image 0.22.0 copy of a NASA Great Images photograph of astronaut Eileen Collins. The scikit-image documentation identifies it as public domain with no known copyright restrictions. It is used only as a positive inference smoke test; no identity recognition is performed.

- Source: https://github.com/scikit-image/scikit-image/blob/v0.22.0/skimage/data/astronaut.png
- Documentation: https://scikit-image.org/docs/0.22.x/api/skimage.data.html#skimage.data.astronaut
- SHA-256: `88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5`

One frontal image is not a representative human/head/scalp validation set. It does not establish performance on outdoor panoramic images, heads cropped by the image edge, or views from above.
