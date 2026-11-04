export const createCanvas = (canvas) => {
    const ctx = canvas.getContext('2d');

    const size = {
        width: 0,
        height: 0
    }

    function resize() {
        const dpr = window.devicePixelRatio || 1;

        size.width = window.innerWidth;
        size.height = window.innerHeight;

        canvas.width = Math.round(size.width * dpr);
        canvas.height = Math.round(size.height * dpr);

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    window.addEventListener('resize', resize);
    resize();

    return { ctx, size };
}