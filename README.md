# ProvaAI landing page

Responsive, single-page React marketing site for the ProvaAI virtual try-on concept.

## Run locally

Requires Node.js 20.19+ or 22.12+.

```sh
npm install
npm run dev
```

Create a production bundle with `npm run build`.

## Included interactions

- AZ / EN / RU language switcher, with Azerbaijani selected by default
- Light and dark themes
- Responsive section navigation and mobile menu
- Product mockup with size selection and a Hugging Face IDM-VTON photo try-on flow
- Accessible range input for the before/after comparison
- FAQ accordion and front-end-only demo request success state

## Hugging Face virtual try-on (local development)

1. Create a Hugging Face token with read access and set `HF_TOKEN` in `.env.local`. Never put the token in React code or commit it.
2. Restart `npm run dev`. The Vite development server exposes `POST /api/try-on`, uploads the person and garment images to the public `yisol/IDM-VTON` Space, queues its `/tryon` function, and returns the generated result. The token stays server-side; photos are sent to Hugging Face for inference and are not written to this app's disk.

The Space uses shared free GPU capacity and may queue, throttle, or become unavailable. The IDM-VTON model is licensed CC-BY-NC-SA 4.0, so this setup is for non-commercial testing only. Review Hugging Face's [Space API guide](https://huggingface.co/docs/hub/en/spaces-api-endpoints), [ZeroGPU limits](https://huggingface.co/docs/hub/spaces-zerogpu), and the [model license](https://huggingface.co/yisol/IDM-VTON) before using real customer photos. For production deployment, replace this development middleware with a protected backend and a commercially licensed try-on provider.

Product imagery is loaded from the bundled demo assets. Pricing and performance metrics are placeholders and illustrative. The demo request form remains frontend-only.
